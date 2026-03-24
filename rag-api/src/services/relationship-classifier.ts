/**
 * Relationship Classifier — LLM-powered classification of memory relationships.
 *
 * Replaces threshold-based detection (score > 0.85 = supersedes, keywords = contradicts)
 * with semantic understanding via utility LLM calls.
 *
 * Batched: up to 10 candidates per LLM call.
 * Fallback: if LLM fails, returns empty (caller should fall back to threshold-based).
 */

import { llm } from './llm';
import { logger } from '../utils/logger';
import config from '../config';

// ── Types ─────────────────────────────────────────────────

export type ExtendedRelationType =
  | 'supersedes'
  | 'contradicts'
  | 'caused_by'
  | 'follow_up'
  | 'refines'
  | 'alternative_to'
  | 'relates_to'
  | 'none';

export interface ClassifiedRelation {
  targetId: string;
  type: ExtendedRelationType;
  reason: string;
  confidence: number;  // 0-1
}

export interface ClassificationCandidate {
  id: string;
  content: string;
  type: string;
}

// ── Prompts ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory relationship classifier. Given a NEW memory and EXISTING memories, classify the relationship between the new memory and each existing one.

Relationship types:
- supersedes: New memory replaces old (same topic, more complete or more recent information)
- contradicts: Conflicting information about the same topic (different conclusions)
- caused_by: The old event/decision caused or led to the new insight/outcome
- follow_up: New memory continues work started in old memory
- refines: New memory adds detail or specificity to old memory
- alternative_to: New memory describes a different approach to the same problem
- relates_to: Loosely related but no stronger relationship applies
- none: No meaningful relationship

Respond with JSON array. Each element: {"id": "<candidate_id>", "type": "<relationship_type>", "reason": "<brief reason>", "confidence": <0.0-1.0>}

Rules:
- Only classify as "supersedes" if the new memory truly replaces the old (not just similar)
- "contradicts" requires actual conflicting information, not just different topics
- Prefer "none" over weak "relates_to" — avoid creating noise relationships
- Confidence below 0.5 means you're guessing — use "none" instead
- Be concise in reasons (under 50 words)`;

// ── Service ───────────────────────────────────────────────

class RelationshipClassifierService {
  /**
   * Classify relationships between a new memory and candidate existing memories.
   * Returns only meaningful relationships (excludes "none" and low-confidence).
   */
  async classify(
    newMemory: { content: string; type: string },
    candidates: ClassificationCandidate[]
  ): Promise<ClassifiedRelation[]> {
    if (candidates.length === 0) return [];

    // Batch: process up to 10 candidates per call
    const batches = this.chunk(candidates, 10);
    const results: ClassifiedRelation[] = [];

    for (const batch of batches) {
      try {
        const batchResults = await this.classifyBatch(newMemory, batch);
        results.push(...batchResults);
      } catch (error) {
        logger.debug('Relationship classification batch failed', { error });
        // Continue with remaining batches
      }
    }

    return results;
  }

  private async classifyBatch(
    newMemory: { content: string; type: string },
    candidates: ClassificationCandidate[]
  ): Promise<ClassifiedRelation[]> {
    const candidateList = candidates
      .map((c, i) => `[${i + 1}] ID: ${c.id}\n    Type: ${c.type}\n    Content: ${c.content.slice(0, 300)}`)
      .join('\n\n');

    const prompt = `NEW MEMORY (type: ${newMemory.type}):
${newMemory.content.slice(0, 500)}

EXISTING MEMORIES:
${candidateList}

Classify the relationship between the NEW memory and each existing memory. Respond with JSON array only.`;

    const result = await llm.completeWithBestProvider(prompt, {
      complexity: 'utility',
      systemPrompt: SYSTEM_PROMPT,
      format: 'json',
      maxTokens: 1000,
      temperature: 0.1,
      think: false,
    });

    return this.parseResponse(result.text, candidates);
  }

  private parseResponse(text: string, candidates: ClassificationCandidate[]): ClassifiedRelation[] {
    try {
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        type?: string;
        reason?: string;
        confidence?: number;
      }>;

      if (!Array.isArray(parsed)) return [];

      const validIds = new Set(candidates.map(c => c.id));
      const validTypes = new Set<string>([
        'supersedes', 'contradicts', 'caused_by', 'follow_up',
        'refines', 'alternative_to', 'relates_to', 'none',
      ]);

      return parsed
        .filter(r =>
          r.id && validIds.has(r.id) &&
          r.type && validTypes.has(r.type) &&
          r.type !== 'none' &&
          (r.confidence ?? 0.5) >= 0.5
        )
        .map(r => ({
          targetId: r.id!,
          type: r.type as ExtendedRelationType,
          reason: (r.reason || '').slice(0, 200),
          confidence: Math.min(1, Math.max(0, r.confidence ?? 0.5)),
        }));
    } catch (error) {
      logger.debug('Failed to parse relationship classification response', { error });
      return [];
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

export const relationshipClassifier = new RelationshipClassifierService();
