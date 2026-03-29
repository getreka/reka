import { Actor, ActorMessage } from './base-actor';
import { logger } from '../utils/logger';

interface MaintenanceActorState {
  lastCycleAt: string;
  totalCycles: number;
  totalMerged: number;
  totalDeleted: number;
  projectsProcessed: number;
}

export class MaintenanceActor extends Actor<MaintenanceActorState, Record<string, unknown>> {
  constructor() {
    super('maintenance', {
      lastCycleAt: '',
      totalCycles: 0,
      totalMerged: 0,
      totalDeleted: 0,
      projectsProcessed: 0,
    });
  }

  async handle(
    actorId: string,
    message: ActorMessage<Record<string, unknown>>,
    state: MaintenanceActorState
  ): Promise<MaintenanceActorState> {
    if (message.type === 'maintenance:cycle') {
      logger.info('MaintenanceActor handling maintenance:cycle', { actorId });
      const { scheduledMaintenance } = await import('../services/scheduled-maintenance');
      await scheduledMaintenance.runCycle();

      return {
        ...state,
        lastCycleAt: new Date().toISOString(),
        totalCycles: state.totalCycles + 1,
      };
    }
    return state;
  }
}

export const maintenanceActor = new MaintenanceActor();
