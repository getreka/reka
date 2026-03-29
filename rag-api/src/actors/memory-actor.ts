import { Actor, ActorMessage } from './base-actor';
import { logger } from '../utils/logger';
import type { MemoryCreatedPayload, MemoryRecalledPayload } from '../events/types';
import type { MemoryType } from '../services/memory';

// Lazy imports to avoid circular deps (same pattern as current worker)
let memoryServiceRef: { _asyncDetectRelationships: Function } | null = null;
let reconsolidationRef: { onRecall: Function } | null = null;

async function getMemoryService(): Promise<{ _asyncDetectRelationships: Function }> {
  if (!memoryServiceRef) {
    const mod = await import('../services/memory');
    memoryServiceRef = mod.memoryService;
  }
  return memoryServiceRef!;
}

async function getReconsolidation(): Promise<{ onRecall: Function }> {
  if (!reconsolidationRef) {
    const mod = await import('../services/reconsolidation');
    reconsolidationRef = mod.reconsolidation;
  }
  return reconsolidationRef!;
}

interface MemoryActorState {
  recentMemoryIds: string[];
  relationshipsDetected: number;
  reconsolidationsRun: number;
  lastActivity: string;
}

const MAX_LRU_SIZE = 100;

type MemoryMessage = MemoryCreatedPayload | MemoryRecalledPayload;

export class MemoryActor extends Actor<MemoryActorState, MemoryMessage> {
  constructor() {
    super('memory', {
      recentMemoryIds: [],
      relationshipsDetected: 0,
      reconsolidationsRun: 0,
      lastActivity: new Date().toISOString(),
    });
  }

  async handle(
    actorId: string,
    message: ActorMessage<MemoryMessage>,
    state: MemoryActorState
  ): Promise<MemoryActorState> {
    state.lastActivity = new Date().toISOString();

    switch (message.type) {
      case 'memory:created': {
        const payload = message.payload as MemoryCreatedPayload;
        const memService = await getMemoryService();

        try {
          await memService._asyncDetectRelationships(
            payload.projectName,
            payload.memoryId,
            payload.content,
            payload.type as MemoryType,
            payload.embedding
          );
          state.relationshipsDetected++;
        } catch (err: any) {
          logger.debug('Async relationship detection failed', {
            error: err.message,
            memoryId: payload.memoryId,
          });
        }

        // Update LRU cache
        state.recentMemoryIds = [
          payload.memoryId,
          ...state.recentMemoryIds.filter((id) => id !== payload.memoryId),
        ].slice(0, MAX_LRU_SIZE);

        break;
      }

      case 'memory:recalled': {
        const payload = message.payload as MemoryRecalledPayload;
        const config = (await import('../config')).default;

        if (config.RECONSOLIDATION_ENABLED && payload.recalledMemories?.length > 0) {
          try {
            const recon = await getReconsolidation();
            await recon.onRecall(payload.projectName, payload.recalledMemories, payload.query);
            state.reconsolidationsRun++;
          } catch (err: any) {
            logger.debug('Async reconsolidation failed', { error: err.message });
          }
        }

        break;
      }
    }

    return state;
  }
}

export const memoryActor = new MemoryActor();
