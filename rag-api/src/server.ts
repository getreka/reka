/**
 * Shared RAG API Server
 *
 * Universal RAG API that supports multiple projects with isolated collections.
 */

import { initTracing, shutdownTracing } from './utils/tracing';
initTracing(); // Must be before any other imports that create HTTP connections

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import config from './config';
import { logger, createRequestLogger } from './utils/logger';
import { recordHttpRequest, getMetrics, getMetricsContentType } from './utils/metrics';
import { vectorStore } from './services/vector-store';
import { cacheService } from './services/cache';
import { embeddingService } from './services/embedding';
import { errorHandler } from './middleware/error-handler';
import { authMiddleware, generateKey, listKeys, revokeKey } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { enforceProjectScope } from './middleware/project-scope';
import { projectNameSchema } from './utils/validation';
import demoAuthRoutes from './routes/demo-auth';
import searchRoutes from './routes/search';
import indexRoutes from './routes/index';
import memoryRoutes from './routes/memory';
import analyticsRoutes from './routes/analytics';
import agentRoutes from './routes/agents';
import qualityRoutes from './routes/quality';
import eventsRoutes from './routes/events';
import tribunalRoutes from './routes/tribunal';
import sensoryRoutes from './routes/sensory';
import adminRoutes from './routes/admin';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      requestLogger: ReturnType<typeof createRequestLogger>;
    }
  }
}

const app: Express = express();

// Trust proxy controls how req.ip is derived from X-Forwarded-For. Secure default:
// trust NOTHING (req.ip = direct socket, XFF ignored) so clients cannot spoof their IP.
// Behind a reverse proxy (e.g. nginx), set TRUST_PROXY to the hop count (e.g. "1") or
// a comma-separated subnet list so req.ip reflects the real client. Rate limiting and
// audit logging depend on this being correct.
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv && trustProxyEnv !== 'false') {
  const asInt = Number(trustProxyEnv);
  app.set('trust proxy', Number.isInteger(asInt) ? asInt : trustProxyEnv);
} else {
  app.set('trust proxy', false);
}

// Measured at startup via verifyEmbeddingDim(). Surfaced through /health so
// operators can confirm the running provider matches VECTOR_SIZE.
let actualEmbeddingDim: number | null = null;

async function verifyEmbeddingDim(): Promise<void> {
  try {
    const probe = await embeddingService.embed('reka embedding dim probe');
    actualEmbeddingDim = probe.length;
    if (probe.length !== config.VECTOR_SIZE) {
      const msg = `Embedding dim mismatch: provider returned ${probe.length}, VECTOR_SIZE=${config.VECTOR_SIZE}`;
      if (config.EMBEDDING_STARTUP_DIM_CHECK) {
        logger.error(
          msg + ' — refusing to start (set EMBEDDING_STARTUP_DIM_CHECK=false to bypass)'
        );
        process.exit(1);
      }
      logger.warn(msg);
    } else {
      logger.info(
        `Embedding dim probe ok: ${probe.length}d (provider: ${config.EMBEDDING_PROVIDER})`
      );
    }
  } catch (err: any) {
    // Provider unreachable at boot — log + continue. The first real request will surface the error.
    logger.warn('Embedding dim probe failed (provider may be unreachable)', {
      error: err?.message || String(err),
      provider: config.EMBEDDING_PROVIDER,
    });
  }
}

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://app.getreka.dev',
      'https://api.getreka.dev',
      'https://demo.akeryuu.com',
      'https://cdl.akeryuu.com',
    ];
app.use(
  cors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Project-Name',
      'X-Project-Path',
      'X-Request-ID',
    ],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: '10mb' }));

// Request ID and logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const projectName = (req.headers['x-project-name'] as string) || 'unknown';

  // Attach request context
  req.requestId = requestId;
  req.requestLogger = createRequestLogger(requestId, projectName);

  // Set response header
  res.setHeader('X-Request-ID', requestId);

  // Log and record metrics on finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    req.requestLogger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    recordHttpRequest(req.method, req.path, res.statusCode, duration, projectName);
  });

  next();
});

// Rate limiting BEFORE everything else (including the public auth/waitlist routes) so
// brute-force and abuse are throttled even on unauthenticated endpoints.
app.use(rateLimitMiddleware);

// Demo auth routes (public, before API key auth)
app.use('/api/auth', demoAuthRoutes);

// Waitlist endpoint (public, stores email + plan in Redis)
app.post('/api/waitlist', async (req: Request, res: Response) => {
  try {
    const { email, plan } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const client = cacheService.getClient();
    if (client) {
      await client.lpush(
        'waitlist',
        JSON.stringify({
          email: email.trim().toLowerCase(),
          plan: plan || 'unknown',
          ts: new Date().toISOString(),
          ip: req.ip,
        })
      );
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // fail silently — don't block the user
  }
});

// API key authentication (skips /health and /metrics)
app.use(authMiddleware);

// Health check
app.get('/health', async (req: Request, res: Response) => {
  const cacheStats = await cacheService.getStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      embeddingProvider: config.EMBEDDING_PROVIDER,
      llmProvider: config.LLM_PROVIDER,
      vectorSize: config.VECTOR_SIZE,
      embeddingDim: actualEmbeddingDim,
    },
    cache: cacheStats,
  });
});

// Prometheus metrics endpoint (auth required for /metrics, internal path for Prometheus scraper)
const metricsHandler = async (req: Request, res: Response) => {
  res.set('Content-Type', getMetricsContentType());
  res.end(await getMetrics());
};
app.get('/metrics', metricsHandler);
app.get('/internal/metrics', metricsHandler);

// /api/health — public health check (no auth required)
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Key management — administrative. These mint/list/revoke keys for ARBITRARY projects,
// so they are gated to admins only: a request from loopback (self-hosted localhost
// operator) or one carrying a valid X-Admin-Key matching ADMIN_API_KEY. Without this
// gate any authenticated key could escalate to provision/revoke keys for other tenants.
function requireAdmin(req: Request, res: Response): boolean {
  const adminKey = process.env.ADMIN_API_KEY;
  const provided = req.headers['x-admin-key'];
  if (adminKey && typeof provided === 'string' && provided === adminKey) {
    return true;
  }
  // Loopback check uses the raw socket address, NOT req.ip — req.ip is derived from
  // X-Forwarded-For once trust proxy is on, so a misconfigured edge could let a remote
  // attacker spoof "127.0.0.1". The socket address can't be forged by the client.
  const socketIp = req.socket.remoteAddress || '';
  if (socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1') {
    return true;
  }
  res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  return false;
}

app.post('/api/keys', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const { projectName, label } = req.body || {};
  const parsed = projectNameSchema.safeParse(projectName);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Valid projectName is required', code: 'VALIDATION' });
  }
  const entry = generateKey(parsed.data, typeof label === 'string' ? label : undefined);
  res.json({ key: entry.key, projectName: entry.projectName, id: entry.id });
});

app.get('/api/keys', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(listKeys());
});

app.delete('/api/keys/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const revoked = revokeKey(req.params.id);
  if (!revoked) return res.status(404).json({ error: 'Key not found' });
  res.json({ revoked: true });
});

// Resolve project from key (used by MCP server on connect)
app.get('/api/whoami', (req: Request, res: Response) => {
  const ctx = req.authContext;
  if (!ctx?.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ projectName: ctx.projectName, keyName: ctx.keyName });
});

// Enforce per-key project isolation on every data route: a request may only target
// its own project's collections / projectName. Mounted AFTER /api/keys and /api/whoami
// (which legitimately reference other projects) and BEFORE all data routes.
app.use('/api', enforceProjectScope);

// API routes
app.use('/api', searchRoutes);
app.use('/api', indexRoutes);
app.use('/api', memoryRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', agentRoutes);
app.use('/api', qualityRoutes);
app.use('/api', eventsRoutes);
app.use('/api', tribunalRoutes);
app.use('/api', sensoryRoutes);
app.use('/api/admin', adminRoutes);

// Legacy routes for backward compatibility with cypro-rag MCP
app.use('/api/dev/codebase', (req, res, next) => {
  // This route hardcodes the 'cypro' project, so it must not be reachable by keys
  // scoped to a different project (it would otherwise bypass enforceProjectScope and
  // expose cypro's data). Anonymous/legacy callers are allowed (single trust domain).
  const ctx = req.authContext;
  if (ctx?.authenticated && ctx.projectName !== 'cypro') {
    return res.status(403).json({
      error: 'Legacy cypro route not available for this project',
      code: 'PROJECT_SCOPE_VIOLATION',
    });
  }

  // Map old endpoints to new ones
  const projectName = 'cypro';
  req.headers['x-project-name'] = projectName;

  if (req.path === '/search') {
    req.body.collection = `${projectName}_codebase`;
    return searchRoutes(req, res, next);
  }
  if (req.path === '/ask') {
    req.body.collection = `${projectName}_codebase`;
    return searchRoutes(req, res, next);
  }
  next();
});

// Global error handler
app.use(errorHandler);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
export async function startServer(): Promise<void> {
  try {
    // Initialize cache
    logger.info('Initializing cache...');
    await cacheService.initialize();

    // Initialize vector store
    logger.info('Initializing vector store...');
    await vectorStore.initialize();

    // Probe embedding provider so we fail fast on dim mismatch and surface
    // the actual dim through /health.
    await verifyEmbeddingDim();

    // Start heartbeat monitor
    const { heartbeatMonitor } = await import('./services/heartbeat');
    heartbeatMonitor.start();

    // Start scheduled maintenance (dedup, cleanup)
    const { scheduledMaintenance } = await import('./services/scheduled-maintenance');
    await scheduledMaintenance.start();

    // Initialize BullMQ event queues + workers + Bull Board
    const { createBullBoard } = await import('@bull-board/api');
    const { BullMQAdapter } = await import('@bull-board/api/bullMQAdapter');
    const { ExpressAdapter } = await import('@bull-board/express');
    const { getQueue } = await import('./events/queues');

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: ['session-lifecycle', 'indexing', 'maintenance', 'llm-batch', 'dead-letter'].map(
        (name) => new BullMQAdapter(getQueue(name as Parameters<typeof getQueue>[0]))
      ),
      serverAdapter,
    });

    app.use('/admin/queues', serverAdapter.getRouter());

    // Start session-lifecycle worker (consolidation, stale detection, WM cleanup)
    const { startSessionLifecycleWorker } =
      await import('./events/workers/session-lifecycle.worker');
    startSessionLifecycleWorker();

    // Start llm-batch worker (Anthropic Message Batches poll/dispatch — M4)
    const { startLlmBatchWorker } = await import('./events/workers/llm-batch.worker');
    startLlmBatchWorker();

    logger.info('BullMQ event queues initialized with Bull Board at /admin/queues');

    // Start Actor System
    const { actorSystem } = await import('./actors/actor-system');
    const { memoryActor } = await import('./actors/memory-actor');
    const { sessionActor } = await import('./actors/session-actor');
    const { maintenanceActor } = await import('./actors/maintenance-actor');
    const { indexActor } = await import('./actors/index-actor');

    actorSystem.register(memoryActor, 3); // 3 concurrent project actors
    actorSystem.register(sessionActor, 5); // 5 concurrent session actors
    actorSystem.register(maintenanceActor, 1); // singleton, concurrency 1
    actorSystem.register(indexActor, 3); // 3 concurrent project indexing actors

    logger.info('Actor system started', { actors: ['memory', 'session', 'maintenance', 'index'] });

    // Incremental file-watcher re-index (off by default). When enabled, watches
    // the configured project's working tree and incrementally re-indexes files
    // as they change — closing the "stale index" gap. Guarded so a watcher
    // failure can never abort server startup.
    if (process.env.FILE_WATCHER_ENABLED === 'true') {
      try {
        const watchPath = process.env.WATCH_PATH || process.env.PROJECT_PATH;
        const watchProject = process.env.WATCH_PROJECT || process.env.PROJECT_NAME;
        if (watchPath && watchProject) {
          const { fileWatcher } = await import('./services/file-watcher');
          fileWatcher.start(watchProject, watchPath);
          logger.info('File watcher enabled', { project: watchProject, path: watchPath });
        } else {
          logger.warn(
            'FILE_WATCHER_ENABLED=true but WATCH_PROJECT/PROJECT_NAME or WATCH_PATH/PROJECT_PATH is unset — skipping watcher'
          );
        }
      } catch (err: any) {
        logger.warn('Failed to initialize file watcher', { error: err?.message || String(err) });
      }
    }

    // Phase 5: Unix domain socket support via API_SOCKET_PATH
    const socketPath = process.env.API_SOCKET_PATH;
    if (socketPath) {
      const fs = await import('fs');
      // Clean up stale socket from previous crash
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* no stale socket */
      }

      app.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o777);
        logger.info(`Shared RAG API listening on Unix socket: ${socketPath}`);
        logger.info(`Embedding: ${config.EMBEDDING_PROVIDER}, LLM: ${config.LLM_PROVIDER}`);
        logger.info(`Cache: ${cacheService.isEnabled() ? 'enabled' : 'disabled'}`);
      });
    } else {
      app.listen(config.API_PORT, config.API_HOST, () => {
        logger.info(`Shared RAG API running at http://${config.API_HOST}:${config.API_PORT}`);
        logger.info(`Embedding: ${config.EMBEDDING_PROVIDER}, LLM: ${config.LLM_PROVIDER}`);
        logger.info(`Cache: ${cacheService.isEnabled() ? 'enabled' : 'disabled'}`);
      });
    }
  } catch (error: any) {
    logger.error('Failed to start server', { error: error?.message || error, stack: error?.stack });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  const { heartbeatMonitor } = await import('./services/heartbeat');
  heartbeatMonitor.stop();
  // Tear down file watchers (no-op if none were started).
  if (process.env.FILE_WATCHER_ENABLED === 'true') {
    try {
      const { fileWatcher } = await import('./services/file-watcher');
      await fileWatcher.stopAll();
    } catch {
      /* watcher may not have started */
    }
  }
  const { llmUsageLogger } = await import('./services/llm-usage-logger');
  await llmUsageLogger.shutdown();
  const { actorSystem } = await import('./actors/actor-system');
  await actorSystem.shutdown();
  const { closeAll } = await import('./events/queues');
  await closeAll(); // Still needed for event queues (maintenance, indexing, dead-letter)
  const { lspClient } = await import('./services/lsp-client');
  await lspClient.shutdown();
  await shutdownTracing();
  // Phase 5: Clean up Unix socket on shutdown
  const socketPath = process.env.API_SOCKET_PATH;
  if (socketPath) {
    const fs = await import('fs');
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already removed */
    }
  }
  process.exit(0);
});

// Run if executed directly
if (require.main === module) {
  startServer();
}

export default app;
