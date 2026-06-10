# Rate Limiting Middleware Implementation Plan

## Objective

Implement IP-based rate limiting middleware for the RAG API: max 100 requests per minute per IP.

## Architecture Decision

### Approach: Dual-layer (in-memory + Redis)

- **Primary**: In-memory sliding window using a Map of timestamped request arrays per IP
- **Fallback**: Redis-backed counters when Redis is available (for multi-instance deployments)
- **Why not express-rate-limit?**: No external dependency needed; the project already has Redis infrastructure and prom-client for metrics. A custom implementation fits the existing middleware pattern (see `auth.ts`, `error-handler.ts`) and integrates with existing logger, metrics, and error classes.

## Design

### 1. Configuration (config.ts additions)

New environment variables:

- `RATE_LIMIT_ENABLED`: boolean, default `true`
- `RATE_LIMIT_MAX`: number, default `100` (requests per window)
- `RATE_LIMIT_WINDOW_MS`: number, default `60000` (1 minute in ms)
- `RATE_LIMIT_SKIP_PATHS`: paths to skip, default `/health,/metrics`

### 2. Middleware: `rag-api/src/middleware/rate-limiter.ts`

**Sliding window algorithm**:

- Each IP gets an array of request timestamps
- On each request, prune timestamps older than the window
- If count >= max, reject with 429
- Otherwise, record the timestamp and continue

**Response headers** (standard):

- `X-RateLimit-Limit`: max requests per window
- `X-RateLimit-Remaining`: remaining requests in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets

**429 response format** (matches existing error pattern):

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

### 3. Prometheus Metrics

New counters in `metrics.ts`:

- `rate_limit_hits_total` (labels: ip_hash) -- counts 429 responses
- `rate_limit_requests_tracked` (gauge) -- current tracked IPs

### 4. IP Extraction

Priority order:

1. `X-Forwarded-For` header (first IP) -- for reverse proxy setups
2. `X-Real-IP` header
3. `req.ip` / `req.socket.remoteAddress`

### 5. Memory Management

- Periodic cleanup of stale entries (IPs with no requests in last window)
- Cleanup runs every 5 minutes via `setInterval`
- Cleanup timer is `unref()`'d to not block process exit

### 6. Integration Point in `server.ts`

Insert after CORS and JSON parsing, before auth middleware:

```typescript
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(rateLimitMiddleware); // <-- NEW
app.use(authMiddleware);
```

This placement ensures:

- Rate limiting happens before expensive auth checks
- /health and /metrics are still rate-limited (configurable via skip paths)
- Request ID middleware runs first so rate-limit logs include request context

## Files to Create/Modify

| File                                                    | Action | Description                       |
| ------------------------------------------------------- | ------ | --------------------------------- |
| `rag-api/src/middleware/rate-limiter.ts`                | CREATE | Rate limiting middleware          |
| `rag-api/src/config.ts`                                 | MODIFY | Add rate limit config fields      |
| `rag-api/src/server.ts`                                 | MODIFY | Register rate limit middleware    |
| `rag-api/src/utils/metrics.ts`                          | MODIFY | Add rate limit Prometheus metrics |
| `rag-api/src/__tests__/middleware/rate-limiter.test.ts` | CREATE | Unit tests                        |

## Edge Cases

1. **IPv6 normalization**: Normalize `::ffff:127.0.0.1` to `127.0.0.1`
2. **Proxy trust**: Use `X-Forwarded-For` first IP only
3. **Memory pressure**: Stale entry cleanup every 5 minutes
4. **Graceful degradation**: If Redis is available, use it; otherwise fall back to in-memory
5. **Multiple instances**: In-memory limiter is per-process; Redis mode handles distributed deployments
