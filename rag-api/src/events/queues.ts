import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import config from '../config';
import { logger } from '../utils/logger';
import { eventProcessedTotal, eventProcessingDuration } from '../utils/metrics';

// Parse Redis connection from config
function getRedisConnection(): { host: string; port: number } {
  const url = config.REDIS_URL || 'redis://localhost:6380';
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parseInt(parsed.port || '6380', 10) };
  } catch {
    return { host: 'localhost', port: 6380 };
  }
}

const connection = getRedisConnection();

// Queue registry
const QUEUE_NAMES = [
  'memory-effects',
  'session-lifecycle',
  'indexing',
  'maintenance',
  'llm-batch',
  'dead-letter',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    const q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return queues.get(name)!;
}

export function createWorker<T = unknown>(
  queueName: QueueName,
  processor: Processor<T>,
  opts?: Partial<WorkerOptions>
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection,
    concurrency: opts?.concurrency ?? 3,
    ...opts,
  });

  worker.on('completed', (job) => {
    eventProcessedTotal.inc({ queue: queueName, event_type: job.name, status: 'completed' });
    if (job.processedOn && job.timestamp) {
      const duration = (job.processedOn - job.timestamp) / 1000;
      eventProcessingDuration.observe({ queue: queueName, event_type: job.name }, duration);
    }
    logger.debug(`Job completed: ${queueName}/${job.name}`, { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    eventProcessedTotal.inc({
      queue: queueName,
      event_type: job?.name || 'unknown',
      status: 'failed',
    });
    logger.warn(`Job failed: ${queueName}/${job?.name}`, {
      jobId: job?.id,
      error: err.message,
      attempt: job?.attemptsMade,
    });
  });

  workers.push(worker as Worker);
  return worker;
}

export async function closeAll(): Promise<void> {
  for (const w of workers) {
    await w.close();
  }
  for (const q of queues.values()) {
    await q.close();
  }
  workers.length = 0;
  queues.clear();
}
