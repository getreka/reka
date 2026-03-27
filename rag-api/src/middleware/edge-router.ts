/**
 * Edge Router Middleware
 *
 * Routes requests between local processing and Reka Cloud.
 * - Local ops (indexing, file reading) stay on edge
 * - Remote ops (search, memory, LLM) can be proxied to cloud
 * - Offline queue for cloud-bound requests when disconnected
 *
 * Activated when REKA_CLOUD_URL is set. Otherwise, all requests are local.
 */

import { Request, Response, NextFunction } from 'express';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger';

// Paths that MUST stay local (they access the filesystem)
const LOCAL_ONLY_PATHS = [
  '/api/index',           // Reads local files
  '/api/index/upload',    // Receives file content from MCP
  '/api/index/status',    // Local indexer state
  '/health',
  '/metrics',
  '/api/health',
];

// Paths that SHOULD go to cloud when available
const CLOUD_PREFERRED_PATHS = [
  '/api/search',
  '/api/ask',
  '/api/memory',
  '/api/hybrid-search',
  '/api/review',
  '/api/analytics',
  '/api/project',
];

interface OfflineQueueEntry {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
  timestamp: number;
}

class EdgeRouter {
  private cloudClient: AxiosInstance | null = null;
  private offlineQueue: OfflineQueueEntry[] = [];
  private cloudHealthy = false;
  private lastHealthCheck = 0;
  private healthCheckInterval = 30000; // 30s

  constructor() {
    const cloudUrl = process.env.REKA_CLOUD_URL;
    const cloudKey = process.env.REKA_CLOUD_KEY;

    if (cloudUrl) {
      this.cloudClient = axios.create({
        baseURL: cloudUrl,
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          ...(cloudKey ? { 'Authorization': `Bearer ${cloudKey}` } : {}),
        },
      });
      logger.info(`Edge router: cloud proxy enabled → ${cloudUrl}`);
      this.checkCloudHealth();
    } else {
      logger.info('Edge router: local-only mode (REKA_CLOUD_URL not set)');
    }
  }

  private async checkCloudHealth(): Promise<boolean> {
    if (!this.cloudClient) return false;

    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckInterval) {
      return this.cloudHealthy;
    }

    this.lastHealthCheck = now;
    try {
      await this.cloudClient.get('/health', { timeout: 5000 });
      if (!this.cloudHealthy) {
        logger.info('Edge router: cloud connection restored');
        this.flushOfflineQueue();
      }
      this.cloudHealthy = true;
    } catch {
      if (this.cloudHealthy) {
        logger.warn('Edge router: cloud unreachable, switching to local');
      }
      this.cloudHealthy = false;
    }
    return this.cloudHealthy;
  }

  private isLocalOnly(path: string): boolean {
    return LOCAL_ONLY_PATHS.some(p => path.startsWith(p));
  }

  private isCloudPreferred(path: string): boolean {
    return CLOUD_PREFERRED_PATHS.some(p => path.startsWith(p));
  }

  private async flushOfflineQueue(): Promise<void> {
    if (!this.cloudClient || this.offlineQueue.length === 0) return;

    logger.info(`Edge router: flushing ${this.offlineQueue.length} queued requests to cloud`);
    const queue = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const entry of queue) {
      try {
        await this.cloudClient.request({
          method: entry.method,
          url: entry.path,
          data: entry.body,
          headers: entry.headers,
        });
      } catch (err) {
        logger.warn(`Edge router: failed to flush ${entry.method} ${entry.path}`);
        // Re-queue if cloud went down again
        if (!this.cloudHealthy) {
          this.offlineQueue.push(entry);
          break;
        }
      }
    }
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      // No cloud configured — everything is local
      if (!this.cloudClient) {
        return next();
      }

      // Local-only paths always handled locally
      if (this.isLocalOnly(req.path)) {
        return next();
      }

      // Check if cloud is available
      const cloudAvailable = await this.checkCloudHealth();

      // Cloud-preferred paths: proxy if cloud available, local fallback otherwise
      if (this.isCloudPreferred(req.path) && cloudAvailable) {
        try {
          const cloudRes = await this.cloudClient!.request({
            method: req.method.toLowerCase(),
            url: req.path,
            data: req.body,
            headers: {
              'X-Project-Name': req.headers['x-project-name'] as string || '',
              'X-Project-Path': req.headers['x-project-path'] as string || '',
              'X-Edge-Id': process.env.REKA_EDGE_ID || 'unknown',
            },
            params: req.query,
          });

          return res.status(cloudRes.status).json(cloudRes.data);
        } catch (err) {
          const axErr = err as AxiosError;
          // If cloud returned a real error (4xx), forward it
          if (axErr.response && axErr.response.status < 500) {
            return res.status(axErr.response.status).json(axErr.response.data);
          }
          // Otherwise fall through to local
          logger.warn(`Edge router: cloud failed for ${req.path}, falling back to local`);
        }
      }

      // For write operations when cloud is down, queue for later sync
      if (!cloudAvailable && req.method !== 'GET' && this.isCloudPreferred(req.path)) {
        this.offlineQueue.push({
          method: req.method.toLowerCase(),
          path: req.path,
          body: req.body,
          headers: {
            'X-Project-Name': req.headers['x-project-name'] as string || '',
            'X-Project-Path': req.headers['x-project-path'] as string || '',
          },
          timestamp: Date.now(),
        });
      }

      // Fall through to local processing
      next();
    };
  }

  getStatus() {
    return {
      mode: this.cloudClient ? 'hybrid' : 'local',
      cloudUrl: process.env.REKA_CLOUD_URL || null,
      cloudHealthy: this.cloudHealthy,
      offlineQueueSize: this.offlineQueue.length,
    };
  }
}

export const edgeRouter = new EdgeRouter();
