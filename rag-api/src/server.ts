/**
 * Shared RAG API Server
 *
 * Universal RAG API that supports multiple projects with isolated collections.
 */

import { initTracing, shutdownTracing } from './utils/tracing';
initTracing();  // Must be before any other imports that create HTTP connections

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import config from './config';
import { logger, createRequestLogger } from './utils/logger';
import { recordHttpRequest, getMetrics, getMetricsContentType } from './utils/metrics';
import { vectorStore } from './services/vector-store';
import { cacheService } from './services/cache';
import { errorHandler } from './middleware/error-handler';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { edgeRouter } from './middleware/edge-router';
import { meteringMiddleware } from './middleware/metering';
import searchRoutes from './routes/search';
import indexRoutes from './routes/index';
import memoryRoutes from './routes/memory';
import reviewRoutes from './routes/review';
import testingRoutes from './routes/testing';
import analyticsRoutes from './routes/analytics';
import agentRoutes from './routes/agents';
import pmRoutes from './routes/pm';
import qualityRoutes from './routes/quality';
import eventsRoutes from './routes/events';
import tribunalRoutes from './routes/tribunal';
import sensoryRoutes from './routes/sensory';
import billingRoutes from './routes/billing';

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

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Project-Name', 'X-Project-Path', 'X-Request-ID'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '10mb' }));

// Request ID and logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const projectName = req.headers['x-project-name'] as string || 'unknown';

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

// API key authentication (skips /health and /metrics)
app.use(authMiddleware);

// Rate limiting (tiered: default/llm/indexing)
app.use(rateLimitMiddleware);

// Edge router (proxies to cloud when REKA_CLOUD_URL is set)
app.use(edgeRouter.middleware());

// Usage metering (tracks API calls when REKA_BILLING_ENABLED=true)
app.use(meteringMiddleware);

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
    },
    cache: cacheStats,
    edge: edgeRouter.getStatus(),
  });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req: Request, res: Response) => {
  res.set('Content-Type', getMetricsContentType());
  res.end(await getMetrics());
});

// /api/health — public health check (no auth required)
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api', searchRoutes);
app.use('/api', indexRoutes);
app.use('/api', memoryRoutes);
app.use('/api', reviewRoutes);
app.use('/api', testingRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', agentRoutes);
app.use('/api', pmRoutes);
app.use('/api', qualityRoutes);
app.use('/api', eventsRoutes);
app.use('/api', tribunalRoutes);
app.use('/api', sensoryRoutes);
app.use('/api/billing', billingRoutes);

// Legacy routes for backward compatibility with cypro-rag MCP
app.use('/api/dev/codebase', (req, res, next) => {
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

    // Start heartbeat monitor
    const { heartbeatMonitor } = await import('./services/heartbeat');
    heartbeatMonitor.start();

    // Start server
    app.listen(config.API_PORT, config.API_HOST, () => {
      logger.info(`Shared RAG API running at http://${config.API_HOST}:${config.API_PORT}`);
      logger.info(`Embedding: ${config.EMBEDDING_PROVIDER}, LLM: ${config.LLM_PROVIDER}`);
      logger.info(`Cache: ${cacheService.isEnabled() ? 'enabled' : 'disabled'}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  const { heartbeatMonitor } = await import('./services/heartbeat');
  heartbeatMonitor.stop();
  const { llmUsageLogger } = await import('./services/llm-usage-logger');
  await llmUsageLogger.shutdown();
  await shutdownTracing();
  process.exit(0);
});

// Run if executed directly
if (require.main === module) {
  startServer();
}

export default app;
