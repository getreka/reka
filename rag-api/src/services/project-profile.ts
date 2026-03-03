/**
 * Project Profile Service - Aggregated project intelligence.
 *
 * Builds a compact project profile from:
 * - Codebase index statistics (languages, file counts)
 * - Agent memory (patterns, ADRs, conventions)
 * - LLM-generated summary
 *
 * Cached in Redis with 30-minute TTL for fast access.
 */

import { vectorStore } from './vector-store';
import { memoryService } from './memory';
import { llm } from './llm';
import { cacheService } from './cache';
import { logger } from '../utils/logger';

export interface ProjectProfile {
  projectName: string;
  techStack: {
    languages: Record<string, number>;
    frameworks: string[];
  };
  conventions: {
    patterns: Array<{ name: string; description: string }>;
    adrs: Array<{ title: string; decision: string }>;
  };
  summary: string;
  lastUpdated: string;
}

const PROFILE_CACHE_TTL = 1800; // 30 minutes

class ProjectProfileService {
  private getCacheKey(projectName: string): string {
    return `project_profile:${projectName}`;
  }

  /**
   * Get project profile (from cache or build fresh).
   */
  async getProfile(projectName: string): Promise<ProjectProfile> {
    // Try cache
    const cached = await cacheService.get<ProjectProfile>(this.getCacheKey(projectName));
    if (cached) {
      return cached;
    }

    // Build fresh
    const profile = await this.buildProfile(projectName);

    // Cache
    await cacheService.set(this.getCacheKey(projectName), profile, PROFILE_CACHE_TTL);

    return profile;
  }

  /**
   * Force refresh the profile (bypass cache).
   */
  async refreshProfile(projectName: string): Promise<ProjectProfile> {
    const profile = await this.buildProfile(projectName);
    await cacheService.set(this.getCacheKey(projectName), profile, PROFILE_CACHE_TTL);
    return profile;
  }

  /**
   * Get a compact summary string for enrichment context.
   */
  async getCompactSummary(projectName: string): Promise<string | null> {
    try {
      const profile = await this.getProfile(projectName);
      if (!profile.summary) return null;

      const langs = Object.entries(profile.techStack.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([lang, count]) => `${lang}(${count})`)
        .join(', ');

      return `Project: ${projectName} | Stack: ${langs} | ${profile.summary}`;
    } catch {
      return null;
    }
  }

  // ============================================
  // Profile Building
  // ============================================

  private async buildProfile(projectName: string): Promise<ProjectProfile> {
    const [techStack, conventions] = await Promise.all([
      this.buildTechStack(projectName),
      this.buildConventions(projectName),
    ]);

    // Generate LLM summary
    let summary = '';
    try {
      summary = await this.generateSummary(projectName, techStack, conventions);
    } catch (error: any) {
      logger.warn('Failed to generate project summary', { error: error.message });
      summary = `${projectName} project with ${Object.keys(techStack.languages).length} languages.`;
    }

    return {
      projectName,
      techStack,
      conventions,
      summary,
      lastUpdated: new Date().toISOString(),
    };
  }

  private async buildTechStack(projectName: string): Promise<ProjectProfile['techStack']> {
    const languages: Record<string, number> = {};
    const frameworks: string[] = [];

    try {
      const stats = await vectorStore.aggregateStats(`${projectName}_codebase`);
      Object.assign(languages, stats.languages);
    } catch {
      // Codebase may not be indexed yet
    }

    // Detect frameworks from language distribution
    if (languages.typescript || languages.javascript) {
      frameworks.push('Node.js');
    }
    if (languages.vue) {
      frameworks.push('Vue.js');
    }
    if (languages.python) {
      frameworks.push('Python');
    }

    return { languages, frameworks };
  }

  private async buildConventions(projectName: string): Promise<ProjectProfile['conventions']> {
    const patterns: Array<{ name: string; description: string }> = [];
    const adrs: Array<{ title: string; decision: string }> = [];

    try {
      // Get patterns from memory
      const patternResults = await memoryService.recall({
        projectName,
        query: 'architectural pattern convention',
        type: 'context',
        limit: 10,
      });
      for (const r of patternResults) {
        if (r.score >= 0.5) {
          patterns.push({
            name: r.memory.relatedTo || 'pattern',
            description: r.memory.content.slice(0, 200),
          });
        }
      }
    } catch {
      // No patterns yet
    }

    try {
      // Get ADRs from memory
      const adrResults = await memoryService.recall({
        projectName,
        query: 'architecture decision record',
        type: 'decision',
        limit: 10,
      });
      for (const r of adrResults) {
        if (r.score >= 0.5) {
          adrs.push({
            title: r.memory.relatedTo || 'decision',
            decision: r.memory.content.slice(0, 200),
          });
        }
      }
    } catch {
      // No ADRs yet
    }

    return { patterns, adrs };
  }

  private async generateSummary(
    projectName: string,
    techStack: ProjectProfile['techStack'],
    conventions: ProjectProfile['conventions']
  ): Promise<string> {
    const langList = Object.entries(techStack.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang, count]) => `${lang}: ${count} files`)
      .join(', ');

    const patternList = conventions.patterns
      .slice(0, 5)
      .map(p => p.description)
      .join('; ');

    const adrList = conventions.adrs
      .slice(0, 5)
      .map(a => a.decision)
      .join('; ');

    const prompt = `Summarize this project in 2-3 sentences:
Project: ${projectName}
Languages: ${langList || 'unknown'}
Frameworks: ${techStack.frameworks.join(', ') || 'unknown'}
Patterns: ${patternList || 'none documented'}
Decisions: ${adrList || 'none documented'}`;

    const result = await llm.complete(prompt, {
      systemPrompt: 'You are a project analyst. Provide a concise 2-3 sentence summary of the project. Focus on what it does and its key technical characteristics.',
      maxTokens: 200,
      temperature: 0.3,
      think: false,
    });

    return result.text.trim();
  }
}

export const projectProfileService = new ProjectProfileService();
export default projectProfileService;
