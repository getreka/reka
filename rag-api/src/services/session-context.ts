/**
 * Session Context Service - Manage session state and context persistence
 *
 * Features:
 * - Session lifecycle management (start, get, end)
 * - Context persistence across interactions
 * - Session summary and learnings extraction on end
 * - Cross-session context transfer
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { memoryService } from './memory';
import { memoryGovernance } from './memory-governance';
import { conversationAnalyzer } from './conversation-analyzer';
import { usagePatterns } from './usage-patterns';
import { cacheService } from './cache';
import { projectProfileService } from './project-profile';
import { workingMemory } from './working-memory';
// consolidation runs async via session-lifecycle worker (not in endSession request path)
import { logger } from '../utils/logger';
import config from '../config';
import { publishEvent } from '../events/emitter';

export interface SessionContext {
  sessionId: string;
  projectName: string;
  startedAt: string;
  lastActivityAt: string;
  status: 'active' | 'paused' | 'ended';
  // Context data
  currentFiles: string[];
  recentQueries: string[];
  activeFeatures: string[];
  toolsUsed: string[];
  // Accumulated learnings
  pendingLearnings: string[];
  decisions: string[];
  // Metadata
  metadata?: Record<string, unknown>;
}

export interface StartSessionOptions {
  projectName: string;
  sessionId?: string;
  initialContext?: string;
  resumeFrom?: string; // Previous session ID to resume from
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  projectName: string;
  sessionId: string;
  summary?: string;
  autoSaveLearnings?: boolean;
  feedback?: 'productive' | 'neutral' | 'unproductive';
}

export interface SessionSummary {
  sessionId: string;
  duration: number;
  toolsUsed: string[];
  filesAffected: string[];
  queriesCount: number;
  learningsSaved: number;
  summary: string;
  staleMemoriesCount?: number;
  workingMemorySlots?: number;
  sensoryEventCount?: number;
}

class SessionContextService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_sessions`;
  }

  private getCacheKey(projectName: string, sessionId: string): string {
    return `session:${projectName}:${sessionId}`;
  }

  /**
   * Start a new session or resume existing.
   *
   * Returns fast with a minimal context (cache + working memory init only).
   * Heavy operations (stale cleanup, previous session lookup, entity extraction,
   * Qdrant persist, briefing) run in the background and update the cached context
   * when they complete.
   */
  async startSession(options: StartSessionOptions): Promise<SessionContext> {
    const { projectName, sessionId = uuidv4(), metadata } = options;

    // Create minimal context immediately — no I/O
    const context = this.createNewContext(sessionId, projectName, metadata);

    // Store in cache for fast access (Redis only — fast)
    await cacheService.set(
      this.getCacheKey(projectName, sessionId),
      context,
      3600 // 1 hour TTL
    );

    // Initialize working memory for this session (Redis only — fast)
    workingMemory
      .init(projectName, sessionId)
      .catch((err) => logger.debug('Working memory init failed', { error: err.message }));

    logger.info(`Session started (fast): ${sessionId}`, { projectName });

    // Emit domain event (fire-and-forget)
    publishEvent('session:started', {
      projectName,
      sessionId: context.sessionId,
      resumedFrom: options.resumeFrom,
      initialContext: options.initialContext,
    }).catch(() => {});

    // ── Background: heavy operations that enrich the session ──
    this.enrichSessionBackground(context, options).catch((err) =>
      logger.debug('Background session enrichment failed', { error: err.message })
    );

    return context;
  }

  /**
   * Background enrichment: runs after startSession returns.
   * Updates the cached session context with data from previous sessions,
   * entity extraction, Qdrant persistence, and briefing.
   */
  private async enrichSessionBackground(
    context: SessionContext,
    options: StartSessionOptions
  ): Promise<void> {
    const { projectName, initialContext, resumeFrom } = options;
    const { sessionId } = context;
    let enriched = { ...context };

    // 1. Cleanup stale sessions (Qdrant query — can be slow)
    await this.cleanupStaleSessions(projectName).catch((err) =>
      logger.debug('Stale session cleanup failed', { error: err.message })
    );

    // 2. Try to resume from previous session
    try {
      const resumeId = resumeFrom || (await this.findLastSessionId(projectName));
      if (resumeId) {
        const previousContext = await this.getSession(projectName, resumeId);
        if (previousContext) {
          enriched = {
            ...enriched,
            currentFiles: previousContext.currentFiles,
            recentQueries: previousContext.recentQueries.slice(-5),
            activeFeatures: previousContext.activeFeatures,
            decisions: previousContext.decisions,
            metadata: { ...enriched.metadata, resumedFrom: resumeId },
          };
        }
      }
    } catch (err: any) {
      logger.debug('Session resume lookup failed', { error: err.message });
    }

    // 3. Extract entities from initial context
    if (initialContext) {
      try {
        const extracted = await conversationAnalyzer.extractEntities(initialContext);
        enriched.currentFiles = [...enriched.currentFiles, ...extracted.files];
        enriched.activeFeatures = [...enriched.activeFeatures, ...extracted.concepts];
      } catch (err: any) {
        logger.debug('Entity extraction failed', { error: err.message });
      }
    }

    // 4. Persist to Qdrant for durability
    await this.persistSession(enriched).catch((err) =>
      logger.debug('Session persist failed', { error: err.message })
    );

    // 5. Build briefing (project profile + memory recall)
    try {
      const briefing = await this.buildSessionBriefing(enriched);
      if (briefing) {
        enriched.metadata = { ...enriched.metadata, briefing };
      }
    } catch (err: any) {
      logger.debug('Failed to build session briefing', { error: err.message });
    }

    // 6. Update cache with enriched context
    await cacheService.set(this.getCacheKey(projectName, sessionId), enriched, 3600);

    logger.info(`Session enriched (background): ${sessionId}`, {
      projectName,
      files: enriched.currentFiles.length,
      features: enriched.activeFeatures.length,
      hasBriefing: !!enriched.metadata?.briefing,
    });
  }

  /**
   * Get current session context
   */
  async getSession(projectName: string, sessionId: string): Promise<SessionContext | null> {
    // Try cache first
    const cached = await cacheService.get<SessionContext>(this.getCacheKey(projectName, sessionId));
    if (cached) {
      return cached;
    }

    // Fall back to Qdrant
    const collection = this.getCollectionName(projectName);
    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 1,
        with_payload: true,
        filter: {
          must: [{ key: 'sessionId', match: { value: sessionId } }],
        },
      });

      if (results.points.length > 0) {
        const context = results.points[0].payload as unknown as SessionContext;
        // Refresh cache
        await cacheService.set(this.getCacheKey(projectName, sessionId), context, 3600);
        return context;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.error('Failed to get session', { error: error.message });
      }
    }

    return null;
  }

  /**
   * Update session context
   */
  async updateSession(
    projectName: string,
    sessionId: string,
    updates: Partial<SessionContext>
  ): Promise<SessionContext | null> {
    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      return null;
    }

    const updatedContext: SessionContext = {
      ...context,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    // Update cache
    await cacheService.set(this.getCacheKey(projectName, sessionId), updatedContext, 3600);

    // Persist to Qdrant
    await this.persistSession(updatedContext);

    return updatedContext;
  }

  /**
   * Add activity to session (file, query, tool)
   */
  async addActivity(
    projectName: string,
    sessionId: string,
    activity: {
      type: 'file' | 'query' | 'tool' | 'learning' | 'decision';
      value: string;
    }
  ): Promise<void> {
    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    switch (activity.type) {
      case 'file':
        if (!context.currentFiles.includes(activity.value)) {
          context.currentFiles = [...context.currentFiles, activity.value].slice(-20);
        }
        break;
      case 'query':
        context.recentQueries = [...context.recentQueries, activity.value].slice(-50);
        break;
      case 'tool':
        if (!context.toolsUsed.includes(activity.value)) {
          context.toolsUsed.push(activity.value);
        }
        break;
      case 'learning':
        context.pendingLearnings.push(activity.value);
        break;
      case 'decision':
        context.decisions.push(activity.value);
        break;
    }

    await this.updateSession(projectName, sessionId, context);

    // Background: update predictions via event worker
    publishEvent('session:activity', {
      projectName,
      sessionId,
      activityType: 'tool_use',
    }).catch(() => {});
  }

  /**
   * End a session and save learnings
   */
  async endSession(options: EndSessionOptions): Promise<SessionSummary> {
    const { projectName, sessionId, summary, autoSaveLearnings = false, feedback } = options;

    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      // Return graceful summary instead of throwing — session may have expired or never started
      logger.warn(`Session not found: ${sessionId}, returning empty summary`);
      return {
        sessionId,
        duration: 0,
        toolsUsed: [],
        filesAffected: [],
        queriesCount: 0,
        learningsSaved: 0,
        summary: summary || 'Session not found or already ended',
      };
    }

    // Calculate duration
    const startTime = new Date(context.startedAt).getTime();
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Get usage summary
    let usageSummary: any = { toolsUsed: [], filesAffected: [], keyActions: [] };
    try {
      usageSummary = await usagePatterns.summarizeChanges(projectName, sessionId);
    } catch {
      // Ignore errors
    }

    // Consolidation runs async via session:ending event → session-lifecycle worker.
    // Count manual memories saved during this session as learningsSaved.
    let learningsSaved = 0;
    if (!config.CONSOLIDATION_ENABLED && autoSaveLearnings) {
      // Legacy path only when consolidation is disabled
      learningsSaved = await this.legacyExtractLearnings(
        projectName,
        sessionId,
        context,
        autoSaveLearnings
      );
    } else {
      // Count pending learnings + decisions as "already saved" manual memories
      learningsSaved = (context.pendingLearnings?.length || 0) + (context.decisions?.length || 0);
    }

    // Update session status
    await this.updateSession(projectName, sessionId, {
      status: 'ended',
      metadata: {
        ...context.metadata,
        endedAt: new Date().toISOString(),
        feedback,
        summary: summary || usageSummary.summary,
      },
    });

    // Clear from active cache
    await cacheService.delete(this.getCacheKey(projectName, sessionId));

    // Emit domain event (in-process SSE + BullMQ when enabled)
    publishEvent('session:ending', {
      projectName,
      sessionId,
      summary,
    }).catch(() => {});

    // Stale detection, working memory cleanup, and consolidation handled by
    // session-lifecycle worker via session:ending event
    const staleMemoriesCount = 0;
    const workingMemorySlots = 0;
    const sensoryEventCount = 0;

    const result: SessionSummary = {
      sessionId,
      duration,
      toolsUsed: usageSummary.toolsUsed || context.toolsUsed,
      filesAffected: usageSummary.filesAffected || context.currentFiles,
      queriesCount: context.recentQueries.length,
      learningsSaved,
      summary: summary || usageSummary.summary || 'Session ended',
      staleMemoriesCount,
      workingMemorySlots,
      sensoryEventCount,
    };

    logger.info(`Session ended: ${sessionId}`, {
      duration: Math.round(duration / 1000),
      learningsSaved,
      staleMemories: staleMemoriesCount,
      workingMemorySlots,
      sensoryEventCount,
    });

    return result;
  }

  /**
   * List recent sessions for a project
   */
  async listSessions(
    projectName: string,
    options: { limit?: number; status?: 'active' | 'ended' | 'all' } = {}
  ): Promise<Array<{ sessionId: string; startedAt: string; status: string }>> {
    const { limit = 20, status = 'all' } = options;
    const collection = this.getCollectionName(projectName);

    try {
      const filter: any = { must: [] };
      if (status !== 'all') {
        filter.must.push({ key: 'status', match: { value: status } });
      }

      const results = await vectorStore['client'].scroll(collection, {
        limit,
        with_payload: true,
        filter: filter.must.length > 0 ? filter : undefined,
      });

      return results.points.map((p) => ({
        sessionId: (p.payload as any).sessionId,
        startedAt: (p.payload as any).startedAt,
        status: (p.payload as any).status,
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Build a session briefing with project profile + developer profile + recalled context.
   */
  private async buildSessionBriefing(context: SessionContext): Promise<string | null> {
    const parts: string[] = [];

    // Get project profile summary
    try {
      const summary = await projectProfileService.getCompactSummary(context.projectName);
      if (summary) {
        parts.push(summary);
      }
    } catch {
      // Profile not available yet
    }

    // Add developer profile highlights
    try {
      const devProfile = await usagePatterns.buildDeveloperProfile(context.projectName);
      if (devProfile.totalToolCalls > 0) {
        const topFiles = devProfile.frequentFiles
          .slice(0, 5)
          .map((f) => f.file)
          .join(', ');
        const topTools = devProfile.preferredTools
          .slice(0, 3)
          .map((t) => t.tool)
          .join(', ');
        const peakHrs = devProfile.peakHours
          .slice(0, 2)
          .map((h) => `${h.hour}:00`)
          .join(', ');
        parts.push(
          `Developer: ${devProfile.totalSessions} sessions, top files: ${topFiles}, top tools: ${topTools}, peak hours: ${peakHrs}`
        );
      }
    } catch {
      // Non-critical
    }

    // Auto-recall memories relevant to initial context
    if (context.activeFeatures.length > 0 || context.recentQueries.length > 0) {
      try {
        const query = [...context.activeFeatures, ...context.recentQueries.slice(-3)].join(' ');
        const memories = await memoryService.recall({
          projectName: context.projectName,
          query,
          limit: 5,
          type: 'all',
        });

        const relevant = memories.filter((m) => m.score >= 0.6);
        if (relevant.length > 0) {
          parts.push('Relevant context:');
          for (const m of relevant.slice(0, 5)) {
            parts.push(`- [${m.memory.type}] ${m.memory.content.slice(0, 150)}`);
          }
        }
      } catch {
        // Non-critical
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * End stale active sessions (no activity for 2+ hours).
   */
  private async cleanupStaleSessions(projectName: string): Promise<void> {
    const collection = this.getCollectionName(projectName);
    const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 20,
        with_payload: true,
        filter: {
          must: [
            { key: 'status', match: { value: 'active' } },
            { key: 'lastActivityAt', range: { lte: staleCutoff } },
          ],
        },
      });

      for (const point of results.points) {
        const session = point.payload as unknown as SessionContext;
        await this.updateSession(projectName, session.sessionId, {
          status: 'ended',
          metadata: {
            ...session.metadata,
            endedAt: new Date().toISOString(),
            endReason: 'stale_cleanup',
          },
        });

        // Trigger consolidation via session:ending event (same as normal endSession)
        publishEvent('session:ending', {
          projectName,
          sessionId: session.sessionId,
          summary: 'Auto-ended: stale session (no activity for 2+ hours)',
        }).catch(() => {});

        logger.info(`Cleaned up stale session: ${session.sessionId}`, { projectName });
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.debug('Failed to cleanup stale sessions', { error: error.message });
      }
    }
  }

  /**
   * Find the most recent ended session within 24h for auto-continuity.
   */
  private async findLastSessionId(projectName: string): Promise<string | null> {
    const collection = this.getCollectionName(projectName);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 5,
        with_payload: true,
        filter: {
          should: [
            { key: 'status', match: { value: 'ended' } },
            { key: 'status', match: { value: 'active' } },
          ],
          must: [{ key: 'startedAt', range: { gte: cutoff } }],
        },
      });

      if (results.points.length === 0) return null;

      // Sort by startedAt desc and return the most recent
      const sorted = results.points
        .map((p) => p.payload as unknown as SessionContext)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      return sorted[0]?.sessionId || null;
    } catch (error: any) {
      if (error.status === 404) return null;
      logger.debug('Failed to find last session', { error: error.message });
      return null;
    }
  }

  /**
   * Legacy learning extraction path (pre-consolidation).
   * Saves pending learnings + decisions via governance, then runs conversation analyzer.
   */
  private async legacyExtractLearnings(
    projectName: string,
    sessionId: string,
    context: SessionContext,
    autoSaveLearnings: boolean
  ): Promise<number> {
    let learningsSaved = 0;

    if (autoSaveLearnings && context.pendingLearnings.length > 0) {
      for (const learning of context.pendingLearnings) {
        try {
          await memoryGovernance.ingest({
            projectName,
            content: learning,
            type: 'insight',
            tags: ['session', sessionId.slice(0, 8)],
            metadata: { sessionId },
            source: 'auto_conversation',
          });
          learningsSaved++;
        } catch {
          // Ignore individual failures
        }
      }
    }

    for (const decision of context.decisions) {
      try {
        await memoryGovernance.ingest({
          projectName,
          content: decision,
          type: 'decision',
          tags: ['session', sessionId.slice(0, 8)],
          metadata: { sessionId },
          source: 'auto_conversation',
        });
        learningsSaved++;
      } catch {
        // Ignore individual failures
      }
    }

    if (autoSaveLearnings && context.recentQueries.length > 5) {
      try {
        const querySummary = context.recentQueries.slice(-10).join('\n');
        const extracted = await conversationAnalyzer.analyze({
          projectName,
          conversation: querySummary,
          context: `Session ${sessionId} tool interactions`,
          autoSave: true,
          minConfidence: 0.7,
        });
        learningsSaved += extracted.learnings?.length || 0;
      } catch {
        // Non-critical, ignore
      }
    }

    return learningsSaved;
  }

  private createNewContext(
    sessionId: string,
    projectName: string,
    metadata?: Record<string, unknown>
  ): SessionContext {
    return {
      sessionId,
      projectName,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: 'active',
      currentFiles: [],
      recentQueries: [],
      activeFeatures: [],
      toolsUsed: [],
      pendingLearnings: [],
      decisions: [],
      metadata,
    };
  }

  private async persistSession(context: SessionContext): Promise<void> {
    const collection = this.getCollectionName(context.projectName);

    try {
      // Create embedding from session context
      const contextText = [
        ...context.currentFiles,
        ...context.activeFeatures,
        ...context.recentQueries.slice(-5),
      ].join(' ');

      const embedding = await embeddingService.embed(contextText || `session ${context.sessionId}`);

      const point: VectorPoint = {
        id: context.sessionId,
        vector: embedding,
        payload: context as unknown as Record<string, unknown>,
      };

      await vectorStore.upsert(collection, [point]);
    } catch (error: any) {
      logger.error('Failed to persist session', { error: error.message });
    }
  }
}

export const sessionContext = new SessionContextService();
export default sessionContext;
