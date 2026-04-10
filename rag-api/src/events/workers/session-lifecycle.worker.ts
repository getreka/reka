import { createWorker } from '../queues';
import { logger } from '../../utils/logger';
import type { SensoryEvent } from '../../services/sensory-buffer';

// Lazy imports to avoid circular deps
async function getSessionContext() {
  const mod = await import('../../services/session-context');
  return mod.sessionContext;
}
async function getPredictiveLoader() {
  const mod = await import('../../services/predictive-loader');
  return mod.predictiveLoader;
}
async function getConsolidationAgent() {
  const mod = await import('../../services/consolidation-agent');
  return mod.consolidationAgent;
}
async function getStaleDetector() {
  const mod = await import('../../services/stale-memory-detector');
  return mod.staleMemoryDetector;
}
async function getWorkingMemory() {
  const mod = await import('../../services/working-memory');
  return mod.workingMemory;
}

export function startSessionLifecycleWorker(): void {
  createWorker(
    'session-lifecycle',
    async (job) => {
      const { name, data } = job;

      switch (name) {
        case 'session:started': {
          const { projectName, sessionId } = data as { projectName: string; sessionId: string };

          // Predictive prefetch
          try {
            const ctx = await getSessionContext();
            const session = await ctx.getSession(projectName, sessionId);
            if (session) {
              const loader = await getPredictiveLoader();
              const predictions = await loader.predict(projectName, sessionId, {
                currentFiles: session.currentFiles,
                recentQueries: session.recentQueries,
                toolsUsed: session.toolsUsed,
                activeFeatures: session.activeFeatures,
              });
              if (predictions.length > 0) {
                await loader.prefetch(projectName, sessionId, predictions);
              }
            }
          } catch (err: any) {
            logger.debug('Predictive prefetch failed', { error: err.message, sessionId });
          }

          // Auto-merge similar memories (delegated to memoryService via session-context)
          try {
            const { memoryService } = await import('../../services/memory');
            const result = await memoryService.mergeMemories({
              projectName,
              type: 'all',
              threshold: 0.9,
              dryRun: false,
              limit: 50,
            });
            if (result.totalMerged > 0) {
              logger.info(`Auto-merged ${result.totalMerged} memory clusters on session start`, {
                project: projectName,
              });
            }
          } catch (err: any) {
            logger.debug('Auto-merge failed', { error: err.message });
          }
          break;
        }

        case 'sensory:appended': {
          const { projectName, sessionId, value } = data as {
            projectName: string;
            sessionId: string;
            eventType: string;
            value: SensoryEvent;
          };
          try {
            const wm = await getWorkingMemory();
            await wm.processEvent(projectName, sessionId, value);
          } catch (err: any) {
            logger.debug('Sensory event processing failed', { error: err.message });
          }
          break;
        }

        case 'session:activity': {
          const { projectName, sessionId } = data as { projectName: string; sessionId: string };
          try {
            const ctx = await getSessionContext();
            const session = await ctx.getSession(projectName, sessionId);
            if (session) {
              const loader = await getPredictiveLoader();
              const predictions = await loader.predict(projectName, sessionId, {
                currentFiles: session.currentFiles,
                recentQueries: session.recentQueries,
                toolsUsed: session.toolsUsed,
                activeFeatures: session.activeFeatures,
              });
              if (predictions.length > 0) {
                await loader.prefetch(projectName, sessionId, predictions);
              }
            }
          } catch (err: any) {
            logger.debug('Activity prefetch failed', { error: err.message });
          }
          break;
        }

        case 'session:ending': {
          const { projectName, sessionId } = data as {
            projectName: string;
            sessionId: string;
            summary?: string;
          };

          // Run consolidation agent (skip if short session with manual memories already saved)
          try {
            const { sensoryBuffer } = await import('../../services/sensory-buffer');
            const events = await sensoryBuffer.read(projectName, sessionId, { count: 50 });
            const hasManualMemories = events.some(
              (e) => e.toolName === 'remember' || e.toolName === 'batch_remember'
            );
            const tooFewEvents = events.length < 5;

            if (hasManualMemories && tooFewEvents) {
              logger.info('Consolidation skipped: short session with manual memories', {
                sessionId,
                events: events.length,
              });
            } else {
              const agent = await getConsolidationAgent();
              await agent.consolidate(projectName, sessionId);
              logger.info('Session consolidation completed', { sessionId, events: events.length });
            }
          } catch (err: any) {
            logger.debug('Consolidation failed', { error: err.message, sessionId });
          }

          // Stale memory detection
          try {
            const detector = await getStaleDetector();
            await detector.detectStaleMemories(projectName);
          } catch (err: any) {
            logger.debug('Stale detection failed', { error: err.message });
          }

          // Cleanup working memory
          try {
            const wm = await getWorkingMemory();
            await wm.clear(projectName, sessionId);
          } catch (err: any) {
            logger.debug('Working memory cleanup failed', { error: err.message });
          }
          break;
        }
      }
    },
    { concurrency: 2 }
  );

  logger.info('Session lifecycle worker started');
}
