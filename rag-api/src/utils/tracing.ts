/**
 * OpenTelemetry Tracing Setup
 *
 * Provides distributed tracing with OTLP export (Jaeger-compatible).
 * Auto-instruments HTTP, Express. Custom spans for LLM and embedding.
 *
 * Enable via: OTEL_ENABLED=true OTEL_ENDPOINT=http://jaeger:4318/v1/traces
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_ENDPOINT = process.env.OTEL_ENDPOINT || 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | null = null;

export function initTracing(): void {
  if (!OTEL_ENABLED) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'rag-api',
      [ATTR_SERVICE_VERSION]: '1.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: OTEL_ENDPOINT }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export function shutdownTracing(): Promise<void> {
  return sdk?.shutdown() || Promise.resolve();
}

// ── Custom Span Helpers ──────────────────────────────────────

const tracer = trace.getTracer('rag-api');

/**
 * Wrap an async operation in a traced span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  if (!OTEL_ENABLED) return fn({} as Span);

  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Trace an LLM call.
 */
export function traceLLM<T>(
  provider: string,
  model: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    'llm.completion',
    {
      'llm.provider': provider,
      'llm.model': model,
    },
    fn
  );
}

/**
 * Trace an embedding call.
 */
export function traceEmbedding<T>(
  provider: string,
  batchSize: number,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    'embedding.compute',
    {
      'embedding.provider': provider,
      'embedding.batch_size': batchSize,
    },
    fn
  );
}
