/**
 * Query Learning Service - Learn from feedback to improve queries
 *
 * Features:
 * - Track successful vs unsuccessful queries
 * - Suggest query improvements based on feedback
 * - Learn patterns from better query suggestions
 * - Automatic query rewriting
 */

import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { feedbackService } from './feedback';
import { llm } from './llm';
import { logger } from '../utils/logger';

export interface QueryImprovement {
  originalQuery: string;
  suggestedQuery: string;
  confidence: number;
  reason: string;
  source: 'feedback' | 'pattern' | 'llm';
}

export interface QueryPattern {
  id: string;
  pattern: string;
  improvement: string;
  successRate: number;
  usageCount: number;
}

class QueryLearningService {
  private getPatternCollection(projectName: string): string {
    return `${projectName}_query_patterns`;
  }

  /**
   * Suggest better queries based on learned patterns
   */
  async suggestBetterQuery(options: {
    projectName: string;
    query: string;
    context?: string;
  }): Promise<QueryImprovement[]> {
    const { projectName, query, context } = options;
    const suggestions: QueryImprovement[] = [];

    try {
      // 1. Check feedback-based suggestions first
      const feedbackSuggestions = await feedbackService.getSuggestedQueries(
        projectName,
        query,
        3
      );

      for (const s of feedbackSuggestions) {
        suggestions.push({
          originalQuery: query,
          suggestedQuery: s.betterQuery,
          confidence: s.score,
          reason: 'Based on previous user feedback',
          source: 'feedback',
        });
      }

      // 2. Check learned patterns
      const patternSuggestions = await this.matchPatterns(projectName, query);
      suggestions.push(...patternSuggestions);

      // 3. If no suggestions, use LLM to generate one
      if (suggestions.length === 0) {
        const llmSuggestion = await this.generateLLMSuggestion(query, context);
        if (llmSuggestion) {
          suggestions.push(llmSuggestion);
        }
      }

      // Sort by confidence and deduplicate
      const seen = new Set<string>();
      return suggestions
        .filter(s => {
          const key = s.suggestedQuery.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
    } catch (error: any) {
      logger.error('Failed to suggest better query', { error: error.message });
      return [];
    }
  }

  /**
   * Learn a new query pattern from feedback
   */
  async learnPattern(options: {
    projectName: string;
    originalQuery: string;
    betterQuery: string;
    wasHelpful: boolean;
  }): Promise<void> {
    const { projectName, originalQuery, betterQuery, wasHelpful } = options;
    const collection = this.getPatternCollection(projectName);

    try {
      // Create pattern embedding
      const patternText = `${originalQuery} -> ${betterQuery}`;
      const embedding = await embeddingService.embed(patternText);

      // Check if pattern exists
      const existing = await vectorStore.search(collection, embedding, 1, undefined, 0.95);

      if (existing.length > 0) {
        // Update existing pattern
        const existingPattern = existing[0].payload as unknown as QueryPattern;
        const newUsageCount = existingPattern.usageCount + 1;
        const newSuccessRate = wasHelpful
          ? (existingPattern.successRate * existingPattern.usageCount + 1) / newUsageCount
          : (existingPattern.successRate * existingPattern.usageCount) / newUsageCount;

        const point: VectorPoint = {
          id: existing[0].id,
          vector: embedding,
          payload: {
            ...existingPattern,
            usageCount: newUsageCount,
            successRate: newSuccessRate,
          } as unknown as Record<string, unknown>,
        };

        await vectorStore.upsert(collection, [point]);
      } else {
        // Create new pattern
        const pattern: QueryPattern = {
          id: `pattern_${Date.now()}`,
          pattern: originalQuery,
          improvement: betterQuery,
          successRate: wasHelpful ? 1 : 0,
          usageCount: 1,
        };

        const point: VectorPoint = {
          id: pattern.id,
          vector: embedding,
          payload: pattern as unknown as Record<string, unknown>,
        };

        await vectorStore.upsert(collection, [point]);
      }

      logger.info('Query pattern learned', { originalQuery, betterQuery, wasHelpful });
    } catch (error: any) {
      logger.error('Failed to learn pattern', { error: error.message });
    }
  }

  /**
   * Get learned patterns for a project
   */
  async getPatterns(
    projectName: string,
    limit: number = 20
  ): Promise<QueryPattern[]> {
    const collection = this.getPatternCollection(projectName);

    try {
      // Get high success rate patterns
      const embedding = await embeddingService.embed('query improvement pattern');
      const results = await vectorStore.search(collection, embedding, limit);

      return results
        .map(r => r.payload as unknown as QueryPattern)
        .filter(p => p.successRate > 0.5 && p.usageCount >= 2)
        .sort((a, b) => b.successRate - a.successRate);
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      logger.error('Failed to get patterns', { error: error.message });
      return [];
    }
  }

  /**
   * Analyze query for potential issues
   */
  analyzeQuery(query: string): {
    issues: string[];
    suggestions: string[];
  } {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Check query length
    if (query.length < 10) {
      issues.push('Query is very short');
      suggestions.push('Add more specific terms');
    }

    if (query.length > 500) {
      issues.push('Query is very long');
      suggestions.push('Focus on key terms and concepts');
    }

    // Check for common issues
    if (/^\s*(how|what|why|when|where)\s+/i.test(query)) {
      // Question format is good
    } else if (!/[a-zA-Z]{3,}/.test(query)) {
      issues.push('Query contains no meaningful words');
      suggestions.push('Use descriptive terms');
    }

    // Check for too generic terms
    const genericTerms = ['code', 'function', 'file', 'thing', 'stuff'];
    for (const term of genericTerms) {
      if (new RegExp(`\\b${term}\\b`, 'i').test(query) && query.split(/\s+/).length < 4) {
        issues.push(`Query is too generic (contains "${term}")`);
        suggestions.push('Be more specific about what you\'re looking for');
        break;
      }
    }

    // Check for potential improvements
    if (!query.includes('"') && query.split(/\s+/).length > 3) {
      suggestions.push('Use quotes for exact phrase matching');
    }

    if (query.includes(' or ') || query.includes(' OR ')) {
      suggestions.push('Consider separate queries for better results');
    }

    return { issues, suggestions };
  }

  /**
   * Auto-rewrite a query if it's similar to a previously unsuccessful one.
   * Returns the rewritten query, or the original if no rewrite is applicable.
   */
  async autoRewriteQuery(options: {
    projectName: string;
    query: string;
    minConfidence?: number;
  }): Promise<{ query: string; rewritten: boolean; reason?: string }> {
    const { projectName, query, minConfidence = 0.7 } = options;

    try {
      // 1. Check feedback-based rewrites (highest priority)
      const feedbackSuggestions = await feedbackService.getSuggestedQueries(
        projectName,
        query,
        1
      );

      if (feedbackSuggestions.length > 0 && feedbackSuggestions[0].score >= minConfidence) {
        return {
          query: feedbackSuggestions[0].betterQuery,
          rewritten: true,
          reason: `Rewritten from feedback (score: ${feedbackSuggestions[0].score.toFixed(2)})`,
        };
      }

      // 2. Check learned patterns
      const patternSuggestions = await this.matchPatterns(projectName, query);
      const bestPattern = patternSuggestions.find(s => s.confidence >= minConfidence);
      if (bestPattern) {
        return {
          query: bestPattern.suggestedQuery,
          rewritten: true,
          reason: bestPattern.reason,
        };
      }

      return { query, rewritten: false };
    } catch (error: any) {
      logger.error('Auto-rewrite failed, using original query', { error: error.message });
      return { query, rewritten: false };
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async matchPatterns(
    projectName: string,
    query: string
  ): Promise<QueryImprovement[]> {
    const collection = this.getPatternCollection(projectName);
    const improvements: QueryImprovement[] = [];

    try {
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(collection, embedding, 5, undefined, 0.7);

      for (const r of results) {
        const pattern = r.payload as unknown as QueryPattern;
        if (pattern.successRate >= 0.6 && pattern.usageCount >= 2) {
          improvements.push({
            originalQuery: query,
            suggestedQuery: pattern.improvement,
            confidence: r.score * pattern.successRate,
            reason: `Learned pattern (${Math.round(pattern.successRate * 100)}% success rate)`,
            source: 'pattern',
          });
        }
      }

      return improvements;
    } catch (error: any) {
      if (error.status !== 404) {
        logger.error('Failed to match patterns', { error: error.message });
      }
      return [];
    }
  }

  private async generateLLMSuggestion(
    query: string,
    context?: string
  ): Promise<QueryImprovement | null> {
    try {
      const contextStr = context ? `\nContext: ${context}` : '';
      const prompt = `Given this search query for a codebase: "${query}"${contextStr}

Suggest a better, more specific query that would find more relevant results.
Only respond with the improved query, nothing else.
If the query is already good, respond with "NONE".`;

      const result = await llm.complete(prompt, {
        systemPrompt: 'You are a search query optimizer. Suggest clearer, more specific queries.',
        maxTokens: 100,
        temperature: 0.3,
        think: false,
      });

      const suggested = result.text.trim();
      if (suggested === 'NONE' || suggested.toLowerCase() === query.toLowerCase()) {
        return null;
      }

      return {
        originalQuery: query,
        suggestedQuery: suggested,
        confidence: 0.6,
        reason: 'AI-generated improvement suggestion',
        source: 'llm',
      };
    } catch (error: any) {
      logger.error('Failed to generate LLM suggestion', { error: error.message });
      return null;
    }
  }
}

export const queryLearning = new QueryLearningService();
export default queryLearning;
