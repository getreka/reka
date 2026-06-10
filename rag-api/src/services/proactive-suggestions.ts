/**
 * Proactive Suggestion Service - Context-aware intelligent suggestions
 *
 * Transforms from reactive to proactive assistance by:
 * - Detecting context triggers (files, errors, concepts)
 * - Suggesting relevant resources before being asked
 * - Learning from user patterns
 */

import { vectorStore } from './vector-store';
import { embeddingService } from './embedding';
import { memoryService } from './memory';
import { usagePatterns } from './usage-patterns';
import { logger } from '../utils/logger';

export interface ContextTrigger {
  type: 'file' | 'error' | 'concept' | 'pattern' | 'dependency';
  value: string;
  confidence: number;
}

export interface Suggestion {
  type:
    | 'related_file'
    | 'similar_bug'
    | 'relevant_doc'
    | 'pattern_example'
    | 'memory'
    | 'next_step';
  title: string;
  description: string;
  resource?: string; // file path, memory ID, etc.
  relevance: number; // 0-1
  reason: string;
}

export interface ContextAnalysis {
  triggers: ContextTrigger[];
  suggestions: Suggestion[];
  relatedMemories: Array<{ id: string; content: string; type: string; score: number }>;
  estimatedRelevance: number;
}

export interface AnalyzeContextOptions {
  projectName: string;
  text: string;
  currentFile?: string;
  recentFiles?: string[];
  sessionId?: string;
}

class ProactiveSuggestionService {
  private getCodebaseCollection(projectName: string): string {
    return `${projectName}_codebase`;
  }

  private getMemoryCollection(projectName: string): string {
    return `${projectName}_agent_memory`;
  }

  /**
   * Analyze context and generate proactive suggestions
   */
  async analyzeContext(options: AnalyzeContextOptions): Promise<ContextAnalysis> {
    const { projectName, text, currentFile, recentFiles = [], sessionId } = options;

    const triggers: ContextTrigger[] = [];
    const suggestions: Suggestion[] = [];

    try {
      // 1. Extract triggers from text
      triggers.push(...this.extractTriggers(text));

      // 2. Add file context triggers
      if (currentFile) {
        triggers.push({
          type: 'file',
          value: currentFile,
          confidence: 1.0,
        });
      }

      // 3. Generate suggestions based on triggers
      for (const trigger of triggers) {
        const triggerSuggestions = await this.getSuggestionsForTrigger(
          projectName,
          trigger,
          recentFiles
        );
        suggestions.push(...triggerSuggestions);
      }

      // 4. Get related memories
      const relatedMemories = await this.getRelatedMemories(projectName, text);

      // 5. Add memory-based suggestions
      for (const memory of relatedMemories.slice(0, 3)) {
        suggestions.push({
          type: 'memory',
          title: `Related ${memory.type}`,
          description: memory.content.slice(0, 150),
          resource: memory.id,
          relevance: memory.score,
          reason: `Previously recorded ${memory.type} matches current context`,
        });
      }

      // 6. Add usage pattern suggestions
      if (sessionId) {
        const contextSummary = await usagePatterns.summarizeContext(projectName, sessionId);
        for (const nextStep of contextSummary.suggestedNextSteps) {
          suggestions.push({
            type: 'next_step',
            title: 'Suggested Next Step',
            description: nextStep,
            relevance: 0.7,
            reason: 'Based on your recent activity patterns',
          });
        }
      }

      // 7. Deduplicate and sort by relevance
      const uniqueSuggestions = this.deduplicateSuggestions(suggestions);
      uniqueSuggestions.sort((a, b) => b.relevance - a.relevance);

      // Calculate overall relevance
      const estimatedRelevance =
        triggers.length > 0
          ? triggers.reduce((sum, t) => sum + t.confidence, 0) / triggers.length
          : 0;

      return {
        triggers,
        suggestions: uniqueSuggestions.slice(0, 10),
        relatedMemories,
        estimatedRelevance,
      };
    } catch (error: any) {
      logger.error('Context analysis failed', { error: error.message });
      return {
        triggers,
        suggestions,
        relatedMemories: [],
        estimatedRelevance: 0,
      };
    }
  }

  /**
   * Extract context triggers from text
   */
  private extractTriggers(text: string): ContextTrigger[] {
    const triggers: ContextTrigger[] = [];

    // File path patterns
    const filePatterns =
      text.match(/(?:[\w/-]+\/)?[\w-]+\.(ts|tsx|js|jsx|vue|py|go|rs|java|sql|md)/g) || [];
    for (const file of filePatterns) {
      triggers.push({
        type: 'file',
        value: file,
        confidence: 0.9,
      });
    }

    // Error patterns
    const errorPatterns = [
      /error:?\s*([^\n]+)/gi,
      /exception:?\s*([^\n]+)/gi,
      /failed:?\s*([^\n]+)/gi,
      /TypeError:?\s*([^\n]+)/gi,
      /ReferenceError:?\s*([^\n]+)/gi,
    ];
    for (const pattern of errorPatterns) {
      const matches = text.match(pattern) || [];
      for (const match of matches) {
        triggers.push({
          type: 'error',
          value: match.slice(0, 100),
          confidence: 0.95,
        });
      }
    }

    // Concept patterns (PascalCase identifiers)
    const concepts = text.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g) || [];
    const uniqueConcepts = [...new Set(concepts)];
    for (const concept of uniqueConcepts.slice(0, 5)) {
      triggers.push({
        type: 'concept',
        value: concept,
        confidence: 0.7,
      });
    }

    // Import/dependency patterns
    const importPatterns = text.match(/(?:import|from|require)\s*['"({]([^'"()]+)['")}]/g) || [];
    for (const imp of importPatterns) {
      triggers.push({
        type: 'dependency',
        value: imp,
        confidence: 0.8,
      });
    }

    return triggers;
  }

  /**
   * Get suggestions for a specific trigger
   */
  private async getSuggestionsForTrigger(
    projectName: string,
    trigger: ContextTrigger,
    recentFiles: string[]
  ): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];
    const collection = this.getCodebaseCollection(projectName);

    try {
      switch (trigger.type) {
        case 'file': {
          // Find related files
          const embedding = await embeddingService.embed(`file ${trigger.value}`);
          const results = await vectorStore.search(collection, embedding, 5);

          for (const r of results) {
            const file = r.payload.file as string;
            if (file !== trigger.value && !recentFiles.includes(file)) {
              suggestions.push({
                type: 'related_file',
                title: `Related: ${file}`,
                description: `Similar code structure to ${trigger.value}`,
                resource: file,
                relevance: r.score * trigger.confidence,
                reason: `Found via semantic similarity to ${trigger.value}`,
              });
            }
          }
          break;
        }

        case 'error': {
          // Find similar error fixes
          const embedding = await embeddingService.embed(`fix error ${trigger.value}`);
          const results = await vectorStore.search(collection, embedding, 3);

          for (const r of results) {
            suggestions.push({
              type: 'similar_bug',
              title: `Possible fix in: ${r.payload.file}`,
              description: (r.payload.content as string).slice(0, 100),
              resource: r.payload.file as string,
              relevance: r.score * trigger.confidence,
              reason: `Similar error pattern found`,
            });
          }
          break;
        }

        case 'concept': {
          // Find concept implementations
          const embedding = await embeddingService.embed(trigger.value);
          const results = await vectorStore.search(collection, embedding, 3);

          for (const r of results) {
            suggestions.push({
              type: 'pattern_example',
              title: `${trigger.value} usage in: ${r.payload.file}`,
              description: (r.payload.content as string).slice(0, 100),
              resource: r.payload.file as string,
              relevance: r.score * trigger.confidence,
              reason: `Implementation example of ${trigger.value}`,
            });
          }
          break;
        }

        case 'dependency': {
          // Find where dependency is used
          const embedding = await embeddingService.embed(`import ${trigger.value}`);
          const results = await vectorStore.search(collection, embedding, 3);

          for (const r of results) {
            suggestions.push({
              type: 'pattern_example',
              title: `Import pattern in: ${r.payload.file}`,
              description: (r.payload.content as string).slice(0, 100),
              resource: r.payload.file as string,
              relevance: r.score * trigger.confidence,
              reason: `Similar import usage`,
            });
          }
          break;
        }
      }
    } catch (error: any) {
      logger.warn(`Failed to get suggestions for trigger: ${trigger.type}`, {
        error: error.message,
      });
    }

    return suggestions;
  }

  /**
   * Get related memories for context
   */
  private async getRelatedMemories(
    projectName: string,
    text: string
  ): Promise<Array<{ id: string; content: string; type: string; score: number }>> {
    try {
      const results = await memoryService.recall({
        projectName,
        query: text.slice(0, 500),
        limit: 5,
      });

      return results.map((r) => ({
        id: r.memory.id,
        content: r.memory.content,
        type: r.memory.type,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Deduplicate suggestions by resource
   */
  private deduplicateSuggestions(suggestions: Suggestion[]): Suggestion[] {
    const seen = new Set<string>();
    return suggestions.filter((s) => {
      const key = s.resource || s.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export const proactiveSuggestions = new ProactiveSuggestionService();
export default proactiveSuggestions;
