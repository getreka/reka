/**
 * Quality Gates - Runtime quality monitoring for LLM calls.
 *
 * Wraps LLM calls to collect metrics and detect quality regressions.
 */

import { cacheService } from '../services/cache';
import { logger } from '../utils/logger';

export interface QualityMetrics {
  endpoint: string;
  model: string;
  latencyMs: number;
  jsonParseable: boolean;
  thinkingPresent: boolean;
  thinkingLength: number;
  outputLength: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  timestamp: string;
}

export const QUALITY_THRESHOLDS = {
  jsonParseRate: 0.95,
  maxLatencyP95: 30000,
  thinkingRate: 0.9,
  minOutputLength: 50,
};

const METRICS_KEY = 'quality:metrics';
const MAX_ENTRIES = 1000;

class QualityGateService {
  /**
   * Record a quality metric from an LLM call.
   */
  async record(metric: QualityMetrics): Promise<void> {
    try {
      const existing = (await cacheService.get<QualityMetrics[]>(METRICS_KEY)) || [];
      existing.push(metric);

      // Rolling window: keep only last MAX_ENTRIES
      const trimmed =
        existing.length > MAX_ENTRIES ? existing.slice(existing.length - MAX_ENTRIES) : existing;

      // Cache for 24h
      await cacheService.set(METRICS_KEY, trimmed, 86400);
    } catch (error: any) {
      logger.debug('Quality metric recording failed', { error: error.message });
    }
  }

  /**
   * Generate a quality report.
   */
  async getReport(filterEndpoint?: string): Promise<{
    total: number;
    metrics: {
      avgLatencyMs: number;
      p95LatencyMs: number;
      jsonParseRate: number;
      thinkingRate: number;
      avgOutputLength: number;
      avgThinkingLength: number;
      avgTokens: number;
    };
    alerts: string[];
    byEndpoint: Record<
      string,
      {
        count: number;
        avgLatencyMs: number;
        jsonParseRate: number;
        thinkingRate: number;
      }
    >;
  }> {
    const all = (await cacheService.get<QualityMetrics[]>(METRICS_KEY)) || [];
    const metrics = filterEndpoint ? all.filter((m) => m.endpoint === filterEndpoint) : all;

    if (metrics.length === 0) {
      return {
        total: 0,
        metrics: {
          avgLatencyMs: 0,
          p95LatencyMs: 0,
          jsonParseRate: 1,
          thinkingRate: 0,
          avgOutputLength: 0,
          avgThinkingLength: 0,
          avgTokens: 0,
        },
        alerts: [],
        byEndpoint: {},
      };
    }

    const latencies = metrics.map((m) => m.latencyMs).sort((a, b) => a - b);
    const avgLatencyMs = Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length);
    const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] || 0;

    const jsonParseable = metrics.filter((m) => m.jsonParseable).length;
    // Only count metrics where JSON was expected (non-zero output)
    const jsonCandidates = metrics.filter((m) => m.outputLength > 0);
    const jsonParseRate = jsonCandidates.length > 0 ? jsonParseable / jsonCandidates.length : 1;

    const thinkingPresent = metrics.filter((m) => m.thinkingPresent).length;
    const thinkingRate = metrics.length > 0 ? thinkingPresent / metrics.length : 0;

    const avgOutputLength = Math.round(
      metrics.reduce((s, m) => s + m.outputLength, 0) / metrics.length
    );
    const avgThinkingLength = Math.round(
      metrics.filter((m) => m.thinkingPresent).reduce((s, m) => s + m.thinkingLength, 0) /
        Math.max(thinkingPresent, 1)
    );
    const avgTokens = Math.round(
      metrics.reduce((s, m) => s + m.tokenUsage.total, 0) / metrics.length
    );

    // Check alerts
    const alerts: string[] = [];
    if (jsonParseRate < QUALITY_THRESHOLDS.jsonParseRate) {
      alerts.push(
        `JSON parse rate ${(jsonParseRate * 100).toFixed(1)}% below threshold ${QUALITY_THRESHOLDS.jsonParseRate * 100}%`
      );
    }
    if (p95LatencyMs > QUALITY_THRESHOLDS.maxLatencyP95) {
      alerts.push(
        `P95 latency ${p95LatencyMs}ms exceeds threshold ${QUALITY_THRESHOLDS.maxLatencyP95}ms`
      );
    }
    if (thinkingRate < QUALITY_THRESHOLDS.thinkingRate) {
      alerts.push(
        `Thinking rate ${(thinkingRate * 100).toFixed(1)}% below threshold ${QUALITY_THRESHOLDS.thinkingRate * 100}%`
      );
    }

    // Group by endpoint
    const byEndpoint: Record<
      string,
      { count: number; latencies: number[]; jsonOk: number; thinkingOk: number }
    > = {};
    for (const m of metrics) {
      if (!byEndpoint[m.endpoint]) {
        byEndpoint[m.endpoint] = { count: 0, latencies: [], jsonOk: 0, thinkingOk: 0 };
      }
      const ep = byEndpoint[m.endpoint];
      ep.count++;
      ep.latencies.push(m.latencyMs);
      if (m.jsonParseable) ep.jsonOk++;
      if (m.thinkingPresent) ep.thinkingOk++;
    }

    return {
      total: metrics.length,
      metrics: {
        avgLatencyMs,
        p95LatencyMs,
        jsonParseRate,
        thinkingRate,
        avgOutputLength,
        avgThinkingLength,
        avgTokens,
      },
      alerts,
      byEndpoint: Object.fromEntries(
        Object.entries(byEndpoint).map(([ep, data]) => [
          ep,
          {
            count: data.count,
            avgLatencyMs: Math.round(data.latencies.reduce((s, l) => s + l, 0) / data.count),
            jsonParseRate: data.count > 0 ? data.jsonOk / data.count : 1,
            thinkingRate: data.count > 0 ? data.thinkingOk / data.count : 0,
          },
        ])
      ),
    };
  }

  /**
   * Get active alerts.
   */
  async getAlerts(): Promise<string[]> {
    const report = await this.getReport();
    return report.alerts;
  }
}

export const qualityGates = new QualityGateService();
export default qualityGates;
