# Implementation Plan: Rate Limiting Middleware for RAG API

## Task

Implement rate limiting middleware for the RAG API -- maximum 100 requests per minute per IP address.

## Approach

Implement an in-memory sliding window rate limiter as Express middleware. This follows the established middleware pattern in the project (see `auth.ts`, `async-handler.ts`, `error-handler.ts`). The implementation uses zero external dependencies -- no `express-rate-limit` npm package -- to keep the dependency footprint minimal and match the project's pattern of hand-written middleware.

Key design decisions:

- **Sliding window algorithm** with per-IP tracking using a Map of timestamps
- **In-memory storage** (no Redis dependency for rate limiting; Redis is optional in this project)
- **Configurable** via environment variables: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`
- **Standard HTTP headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **Prometheus metric** for rate-limited requests
- **Skips /health and /metrics** endpoints (same pattern as auth middleware)
- **Periodic cleanup** of expired entries to prevent memory leaks
- **Uses existing `RateLimitError`** from `utils/errors.ts` (already defined in codebase)

## Files to Create

- `rag-api/src/middleware/rate-limit.ts` -- the rate limiting middleware

## Files to Modify

- `rag-api/src/config.ts` -- add `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` config fields
- `rag-api/src/server.ts` -- register `rateLimitMiddleware` after auth middleware
- `rag-api/src/utils/metrics.ts` -- add `rateLimitedRequestsTotal` Prometheus counter

## Blast Radius (from search_graph)

- `server.ts` connects to: all route files (search, index, memory, review, testing, analytics, agents, pm), error-handler, auth, vector-store, cache
- Adding middleware to `server.ts` affects all `/api/*` routes (by design -- rate limiting is global)
- No breaking interface changes: this is additive middleware insertion

## Patterns to Follow

- **Middleware pattern**: Match style of `auth.ts` -- skip certain paths, use `logger` for warnings, return early with JSON error
- **Config pattern**: Add to `Config` interface + parse from env with defaults in `config.ts`
- **Error pattern**: Use existing `RateLimitError` class from `utils/errors.ts`
- **Metrics pattern**: Register counters in `utils/metrics.ts` with `prom-client`
- **Singleton service pattern**: The rate limiter state lives in the middleware module (exported for testing)
