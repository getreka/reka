/**
 * Conversation Analyzer Service - Auto-learning from Claude interactions
 *
 * Analyzes conversations to extract:
 * - Decisions made
 * - Insights discovered
 * - Patterns identified
 * - Entities mentioned (files, functions, concepts)
 */

import { Project } from 'ts-morph';
import { llm } from './llm';
import { memoryService, MemoryType } from './memory';
import { memoryGovernance } from './memory-governance';
import { logger } from '../utils/logger';
import { parseLLMOutput, conversationAnalysisSchema } from '../utils/llm-output';

export interface ExtractedLearning {
  type: MemoryType;
  content: string;
  tags: string[];
  relatedTo?: string;
  confidence: number;
  reasoning: string;
}

export interface ConversationAnalysis {
  learnings: ExtractedLearning[];
  entities: {
    files: string[];
    functions: string[];
    concepts: string[];
  };
  summary: string;
}

export interface AnalyzeOptions {
  projectName: string;
  conversation: string;
  context?: string;
  autoSave?: boolean;
  minConfidence?: number;
}

const ANALYSIS_PROMPT = `Analyze this conversation between a developer and AI assistant. Extract valuable learnings that should be remembered for future sessions.

For each learning, provide:
- type: One of "decision", "insight", "context", "note", "workaround", "pattern"
- content: The actual learning (concise but complete)
- tags: Relevant tags for categorization
- relatedTo: Related feature/module if applicable
- confidence: 0-1 score of how valuable this learning is
- reasoning: Why this should be remembered

Also extract:
- files: File paths mentioned
- functions: Function/class names mentioned
- concepts: Technical concepts discussed

Return JSON:
{
  "learnings": [...],
  "entities": { "files": [], "functions": [], "concepts": [] },
  "summary": "Brief summary of the conversation"
}

Focus on:
1. Architectural decisions made
2. Bug fixes and their root causes
3. Code patterns established
4. Workarounds for issues
5. Important context about the codebase
6. Explanations of how things work

Ignore:
- Generic coding advice
- Obvious statements
- Temporary debugging steps`;

class ConversationAnalyzerService {
  /**
   * Analyze a conversation and extract learnings
   */
  async analyze(options: AnalyzeOptions): Promise<ConversationAnalysis> {
    const {
      projectName,
      conversation,
      context = '',
      autoSave = false,
      minConfidence = 0.6,
    } = options;

    try {
      const contextPrefix = context ? `Context: ${context}\n\n` : '';
      const prompt = `${contextPrefix}Conversation:\n${conversation}`;

      const result = await llm.complete(prompt, {
        systemPrompt: ANALYSIS_PROMPT,
        maxTokens: 2000,
        temperature: 0.3,
        format: 'json',
      });

      const defaultAnalysis: ConversationAnalysis = {
        learnings: [],
        entities: { files: [], functions: [], concepts: [] },
        summary: result.text.slice(0, 200),
      };
      const { data: analysis } = parseLLMOutput(
        result.text,
        conversationAnalysisSchema,
        defaultAnalysis,
        'conversation-analysis'
      ) as { data: ConversationAnalysis; ok: boolean };

      // Filter by confidence
      analysis.learnings = analysis.learnings.filter((l) => l.confidence >= minConfidence);

      // Auto-save if requested
      if (autoSave && analysis.learnings.length > 0) {
        await this.saveLearnings(projectName, analysis.learnings);
      }

      logger.info(`Analyzed conversation: ${analysis.learnings.length} learnings extracted`, {
        projectName,
        entities: analysis.entities,
      });

      return analysis;
    } catch (error: any) {
      logger.error('Conversation analysis failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Save extracted learnings to memory
   */
  async saveLearnings(projectName: string, learnings: ExtractedLearning[]): Promise<string[]> {
    const savedIds: string[] = [];

    for (const learning of learnings) {
      try {
        const memory = await memoryGovernance.ingest({
          projectName,
          content: learning.content,
          type: this.mapLearningType(learning.type),
          tags: [...learning.tags, 'auto-extracted'],
          relatedTo: learning.relatedTo,
          metadata: {
            confidence: learning.confidence,
            reasoning: learning.reasoning,
          },
          source: 'auto_conversation',
          confidence: learning.confidence,
        });
        savedIds.push(memory.id);
      } catch (error: any) {
        logger.warn(`Failed to save learning: ${error.message}`);
      }
    }

    logger.info(`Saved ${savedIds.length} learnings to memory`, { projectName });
    return savedIds;
  }

  /**
   * Map learning type to valid MemoryType
   */
  private mapLearningType(type: string): MemoryType {
    const mapping: Record<string, MemoryType> = {
      decision: 'decision',
      insight: 'insight',
      context: 'context',
      note: 'note',
      workaround: 'insight',
      pattern: 'context',
      todo: 'todo',
      conversation: 'conversation',
    };
    return mapping[type] || 'note';
  }

  /**
   * Extract entities from text using regex for prose + ts-morph AST for code blocks.
   */
  async extractEntities(text: string): Promise<{
    files: string[];
    functions: string[];
    concepts: string[];
  }> {
    const files = new Set<string>();
    const functions = new Set<string>();
    const concepts = new Set<string>();

    // --- Regex extraction from prose ---
    for (const m of text.matchAll(
      /(?:[\w/@.-]+\/)?[\w.-]+\.(ts|js|tsx|jsx|py|go|rs|vue|json|yaml|yml|md)/g
    )) {
      files.add(m[0]);
    }

    for (const m of text.matchAll(
      /(?:function|const|let|var|class|interface|type|enum|def|func)\s+(\w+)/g
    )) {
      if (m[1].length > 1) functions.add(m[1]);
    }

    // Import specifiers: import { X, Y } from '...'
    for (const m of text.matchAll(/import\s+\{([^}]+)\}/g)) {
      for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) {
        if (name && name.length > 1) functions.add(name);
      }
    }

    // Decorators: @Injectable, @Controller
    for (const m of text.matchAll(/@(\w+)/g)) {
      if (m[1].length > 2 && m[1][0] === m[1][0].toUpperCase()) concepts.add(m[1]);
    }

    // PascalCase identifiers as concepts
    for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
      concepts.add(m[1]);
    }

    // --- AST extraction from code blocks ---
    const codeBlocks = [...text.matchAll(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/g)];
    if (codeBlocks.length > 0) {
      try {
        const project = new Project({
          useInMemoryFileSystem: true,
          compilerOptions: { allowJs: true },
        });
        for (const block of codeBlocks.slice(0, 5)) {
          const code = block[1];
          if (code.length < 10 || code.length > 10000) continue;
          try {
            const sf = project.createSourceFile(`__extract_${Math.random()}.ts`, code);
            for (const fn of sf.getFunctions()) {
              const n = fn.getName();
              if (n) functions.add(n);
            }
            for (const cls of sf.getClasses()) {
              const n = cls.getName();
              if (n) functions.add(n);
            }
            for (const ifc of sf.getInterfaces()) {
              const n = ifc.getName();
              if (n) {
                functions.add(n);
                concepts.add(n);
              }
            }
            for (const tp of sf.getTypeAliases()) {
              const n = tp.getName();
              if (n) concepts.add(n);
            }
            for (const en of sf.getEnums()) {
              const n = en.getName();
              if (n) concepts.add(n);
            }
            for (const vd of sf.getVariableDeclarations()) {
              const n = vd.getName();
              if (n && n.length > 1) functions.add(n);
            }
            sf.delete();
          } catch {
            // AST parse failed for this block, skip
          }
        }
      } catch {
        // ts-morph init failed, fall back to regex-only
      }
    }

    return {
      files: [...files],
      functions: [...functions].slice(0, 30),
      concepts: [...concepts].slice(0, 15),
    };
  }
}

export const conversationAnalyzer = new ConversationAnalyzerService();
export default conversationAnalyzer;
