# Summary: Rate Limiting Middleware for RAG API

## Task
Implement rate limiting middleware for the RAG API -- maximum 100 requests per minute per IP.

## RAG Tools Used (rag-implement skill workflow)

### Phase 1: Gather Context
- `start_session` -- initiated tracking session
- `context_briefing(task, files)` -- retrieved memories, patterns, ADRs, graph connections for `server.ts` and `validation.ts`

### Phase 2: Research & Plan
- `suggest_architecture(feature, type: "middleware")` -- got architectural guidance; referenced `auth.ts`, `async-handler.ts`, `error-handler.ts` as middleware exemplars
- `get_patterns(appliesTo: "middleware")` -- no middleware-specific pattern recorded; used general patterns
- `search_graph(query: "server.ts", expandHops: 1)` -- identified 38 connected files; confirmed that middleware insertion in `server.ts` affects all `/api/*` routes (by design)

### Phase 3: Implement
Created 1 new file + 3 modification patches:

| File | Action | Description |
|------|--------|-------------|
| `rate-limit.ts` | **New** | The middleware itself -- sliding window, per-IP tracking |
| `config.ts.patch` | Modify | Add `RATE_LIMIT_MAX` (100) and `RATE_LIMIT_WINDOW_MS` (60000) to Config |
| `server.ts.patch` | Modify | Import + register `rateLimitMiddleware` after `authMiddleware` |
| `metrics.ts.patch` | Modify | Add `rateLimitedRequestsTotal` Prometheus counter |
| `rate-limit.test.ts` | **New** | 10 test cases covering core functionality |

### Phase 4: Verify
- `check_architecture(code, filePath, featureDescription)` -- validated against 5 patterns and 5 ADRs; no violations detected
- `review_code` -- timed out (LLM-dependent), but architecture check passed

### Phase 5: Capture Knowledge
- `remember(type: "insight")` -- saved implementation details and key decisions for future sessions

## Implementation Details

### Algorithm: Sliding Window Rate Limiter
- Stores an array of request timestamps per client IP in a `Map<string, number[]>`
- On each request, prunes timestamps older than the window (default 60s)
- Uses **binary search** (`O(log n)`) for efficient pruning instead of linear scan
- Counts remaining timestamps; if count >= limit (default 100), returns 429

### Key Features
1. **Per-IP tracking** with `X-Forwarded-For` support (first IP in chain)
2. **Standard HTTP headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every response
3. **429 response** includes `Retry-After` header and JSON body with `{ error, code, retryAfter }`
4. **Prometheus metric**: `rate_limited_requests_total` with `ip` and `project` labels
5. **Periodic cleanup** (every 60s) removes expired IPs from the map; uses `.unref()` to avoid blocking process exit
6. **Disable via config**: set `RATE_LIMIT_MAX=0` to disable entirely
7. **Skips /health and /metrics** -- same pattern as auth middleware
8. **Zero new dependencies** -- pure TypeScript, no npm packages added

### Config Changes
```typescript
// Added to Config interface and defaults:
RATE_LIMIT_MAX: number;      // env: RATE_LIMIT_MAX, default: 100
RATE_LIMIT_WINDOW_MS: number; // env: RATE_LIMIT_WINDOW_MS, default: 60000
```

### Middleware Registration Order in server.ts
```
cors() -> express.json() -> requestId/logging -> authMiddleware -> rateLimitMiddleware -> routes
```
Rate limiting comes after auth so that unauthenticated requests are rejected before consuming rate limit quota.

### Test Coverage (10 test cases)
1. Allows requests within the limit
2. Decrements remaining count correctly
3. Returns 429 when limit exceeded
4. Skips /health endpoint
5. Skips /metrics endpoint
6. Tracks IPs independently (per-IP isolation)
7. Respects X-Forwarded-For header
8. getRateLimitStatus returns correct info
9. resetRateLimitState clears all tracking
10. 429 response has proper JSON structure

## Architectural Alignment
- Follows the **middleware pattern** established by `auth.ts` (skip paths, use logger, JSON error responses)
- Uses the **Config pattern** (interface + env parsing with defaults)
- Integrates with existing **Prometheus metrics** system
- Error response structure matches the existing `RateLimitError` class in `utils/errors.ts`
- No ADR violations detected by `check_architecture`
