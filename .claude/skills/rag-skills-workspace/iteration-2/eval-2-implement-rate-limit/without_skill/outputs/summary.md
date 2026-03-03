# Rate Limiting Middleware - Implementation Summary

## What was implemented

IP-based rate limiting middleware for the RAG API with a default limit of 100 requests per minute per IP address, using an in-memory sliding window algorithm.

## Files produced

| File | Purpose |
|------|---------|
| `rate-limiter.ts` | Main middleware implementation (`rag-api/src/middleware/rate-limiter.ts`) |
| `rate-limiter.test.ts` | Unit tests (`rag-api/src/__tests__/middleware/rate-limiter.test.ts`) |
| `config.ts.patch` | Config additions for `rag-api/src/config.ts` |
| `metrics.ts.patch` | Prometheus metric additions for `rag-api/src/utils/metrics.ts` |
| `server.ts.patch` | Integration instructions for `rag-api/src/server.ts` |
| `plan.md` | Detailed implementation plan |

## Integration steps

To apply this to the actual codebase:

### 1. Copy middleware file
```bash
cp rate-limiter.ts /path/to/rag-api/src/middleware/rate-limiter.ts
```

### 2. Update config.ts
Add to the `Config` interface:
```typescript
RATE_LIMIT_ENABLED: boolean;
RATE_LIMIT_MAX: number;
RATE_LIMIT_WINDOW_MS: number;
RATE_LIMIT_SKIP_PATHS: string[];
```

Add to the config object:
```typescript
RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED !== 'false',
RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
RATE_LIMIT_SKIP_PATHS: (process.env.RATE_LIMIT_SKIP_PATHS || '/health,/metrics').split(',').map(p => p.trim()),
```

### 3. Update metrics.ts
Add the `rateLimitHitsTotal` Counter and `rateLimitActiveIPs` Gauge (see `metrics.ts.patch`).

### 4. Update server.ts
Add import and middleware registration:
```typescript
import { rateLimitMiddleware } from './middleware/rate-limiter';
// ... after request ID middleware, before auth:
app.use(rateLimitMiddleware);
```

### 5. Copy test file
```bash
cp rate-limiter.test.ts /path/to/rag-api/src/__tests__/middleware/rate-limiter.test.ts
```

## Design decisions

1. **Sliding window over fixed window**: More accurate rate limiting. A fixed window can allow 2x burst at window boundaries (e.g., 100 requests at end of window 1 + 100 at start of window 2 = 200 in 1 second). The sliding window prevents this.

2. **In-memory over Redis-only**: Zero additional latency. Redis could be added as a second layer for distributed deployments, but the current RAG API is single-instance, so in-memory is sufficient and simpler.

3. **Placed after request ID, before auth**: Rate limit rejection is cheap (no DB/Redis auth lookup), and logs include the request ID for tracing.

4. **IP privacy in metrics/logs**: IPs are hashed for Prometheus labels (to prevent cardinality explosion and privacy leaks) and partially masked in log messages.

5. **No external dependencies**: Reuses existing project patterns -- Express middleware, winston logger, prom-client metrics, and the `AppError`/`RateLimitError` error classes already defined in `utils/errors.ts`.

6. **Configurable via environment**: All parameters (enabled, max, window, skip paths) are configurable via environment variables, following the existing config pattern.

## Response format for 429

```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT",
  "details": {
    "retryAfter": 42,
    "limit": 100,
    "windowMs": 60000
  }
}
```

Standard HTTP headers are set on every response:
- `X-RateLimit-Limit: 100`
- `X-RateLimit-Remaining: 73`
- `X-RateLimit-Reset: 1708950000` (Unix epoch seconds)
- `Retry-After: 42` (only on 429 responses)

## Test coverage

The test suite covers:
- SlidingWindowStore: counting, isolation, expiration, peek, reset time
- IP extraction: X-Forwarded-For, X-Real-IP, req.ip fallback
- IP normalization: IPv6-mapped IPv4 stripping
- IP privacy: masking and hashing
- Middleware integration: allow/reject, headers, skip paths, per-IP isolation, remaining count decrement

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window size in milliseconds |
| `RATE_LIMIT_SKIP_PATHS` | `/health,/metrics` | Comma-separated paths to skip |
