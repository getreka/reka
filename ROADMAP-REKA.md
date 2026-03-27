# Reka Technical Roadmap

**Transforming shared-ai-infra into a market-ready product.**

Current state: 54K LOC TypeScript backend, 776 tests (47 suites), 5-service Docker Compose stack, 35 MCP tools, Vue 3 dashboard with 10 pages, published npm package `@crowley/rag-mcp`.

---

## 1. Critical Path to MVP

### 1a. Authentication & Authorization System

**Description:** The current auth system (`rag-api/src/middleware/auth.ts`) supports a single static `API_KEY` via env var, with timing-safe comparison and Bearer/X-API-Key headers. This needs to evolve into multi-user auth with project-level permissions.

**Files/services affected:**
- `rag-api/src/middleware/auth.ts` — expand from single-key to JWT + API key registry
- `rag-api/src/config.ts` — add `AUTH_PROVIDER`, `JWT_SECRET`, `JWT_EXPIRY`
- `rag-api/src/services/auth.ts` — new service for user/key management
- `rag-api/src/routes/auth.ts` — new routes: login, register, API key CRUD
- `rag-api/src/utils/validation.ts` — add auth-related Zod schemas
- `dashboard/src/pages/LoginPage.vue` — new page
- `dashboard/src/api/client.ts` — attach auth token to Axios interceptor
- `dashboard/src/stores/auth.ts` — new Pinia store
- `dashboard/src/router/index.ts` — add route guards

**Effort:** 8 dev-days

**Dependencies:** None (foundational)

**Acceptance criteria:**
- Users can register/login via dashboard and receive a JWT
- API keys can be created, listed, revoked per-user
- Each API key is scoped to one or more projects (via `allowedProjects: string[]` on the key record)
- All `/api/*` routes (except `/api/health`) require valid JWT or API key
- MCP server passes API key via `X-API-Key` header (already supported)
- Existing single `API_KEY` env var continues to work as a "master key" for backward compatibility
- Rate limiting is per-API-key, not just per-IP (extend `rag-api/src/middleware/rate-limit.ts`)

**Risk:** Medium. JWT secret management, token refresh flow, and password hashing need to be correct. Use `bcrypt` for passwords, `jsonwebtoken` for tokens. Do not build custom crypto.

**Implementation approach:**

```typescript
// rag-api/src/services/auth.ts
interface ApiKeyRecord {
  id: string;
  hashedKey: string;        // bcrypt hash of the key
  userId: string;
  name: string;
  allowedProjects: string[]; // ['*'] for all
  rateLimit?: number;        // custom per-key limit
  createdAt: string;
  lastUsedAt: string;
  expiresAt?: string;
}

// Store API keys in Qdrant collection: `_reka_api_keys`
// Store users in: `_reka_users`
```

```typescript
// rag-api/src/middleware/auth.ts — expanded
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.AUTH_ENABLED) return next();
  if (SKIP_AUTH_PATHS.includes(req.path)) return next();

  // 1. Check master key (backward compat)
  if (config.API_KEY && extractApiKey(req) === config.API_KEY) return next();

  // 2. Check JWT from Authorization: Bearer <jwt>
  const jwt = extractJwt(req);
  if (jwt) {
    try {
      req.user = verifyJwt(jwt);
      return next();
    } catch { return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' }); }
  }

  // 3. Check API key from X-API-Key header
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey) {
    const record = await authService.validateApiKey(apiKey);
    if (!record) return res.status(403).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });

    const projectName = req.body?.projectName || req.headers['x-project-name'];
    if (projectName && !record.allowedProjects.includes('*') && !record.allowedProjects.includes(projectName)) {
      return res.status(403).json({ error: 'API key not authorized for this project', code: 'PROJECT_DENIED' });
    }
    req.user = { id: record.userId, keyId: record.id };
    return next();
  }

  return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
}
```

---

### 1b. One-Line Installer / CLI Tool

**Description:** Create a `reka` CLI that replaces manual Docker Compose setup, env file editing, and curl commands. This is the primary user interface for the product.

**Files/services affected:**
- `cli/` — new package (separate from rag-api and mcp-server)
- `cli/src/index.ts` — entry point with commander.js
- `cli/src/commands/` — one file per command group
- `cli/package.json` — published as `@reka/cli` or `reka`
- `install.sh` — curl-pipe installer script

**Effort:** 12 dev-days

**Dependencies:** 1h (Health check dashboard endpoint — needed for `reka status`)

**Acceptance criteria:**
- `npm install -g reka` or `curl -fsSL https://reka.dev/install | bash` works
- `reka init` scaffolds a project with interactive prompts
- `reka index` triggers indexing with progress bar
- `reka status` shows service health, project stats, memory counts
- `reka search <query>` runs semantic search from terminal
- `reka config` shows/edits configuration
- All commands work without the dashboard (CLI is self-sufficient)
- Exit codes are meaningful (0=success, 1=error, 2=partial)

**Risk:** Medium. Cross-platform compatibility (macOS, Linux, WSL), GPU detection, Docker version requirements.

**Full command tree:** See Section 3.

---

### 1c. Memory Quarantine Review UI

**Description:** The memory governance pipeline (`rag-api/src/services/memory-governance.ts`) routes auto-generated memories to `{project}_memory_pending` collection for quarantine. Currently, promotion/rejection is only available via API calls. Users need a dashboard page to review, promote, reject, and edit quarantined memories.

**Files/services affected:**
- `dashboard/src/pages/MemoryReviewPage.vue` — new page
- `dashboard/src/api/memory.ts` — add review/promote/reject API calls
- `dashboard/src/stores/memory.ts` — extend with quarantine state
- `dashboard/src/router/index.ts` — add `/memory/review` route
- `dashboard/src/types/memory.ts` — add quarantine types
- `rag-api/src/routes/memory.ts` — the promote/review/reject endpoints already exist (lines exist in validation.ts: `promoteMemorySchema`)

**Effort:** 5 dev-days

**Dependencies:** None (APIs already exist)

**Acceptance criteria:**
- Dashboard page shows all quarantined memories in a filterable table (by project, type, tags, confidence score)
- Each memory card shows: content, type, tags, confidence score, source, creation date, related memories
- Batch actions: promote selected, reject selected, merge similar
- Inline editing of memory content and tags before promotion
- Confidence threshold visualization (current adaptive threshold from `getAdaptiveThreshold()`)
- Promotion records the reason (`human_validated`)
- Rejection removes from quarantine with optional feedback
- Memory diff view when a quarantined memory would supersede an existing durable memory

**Risk:** Low. All backend APIs exist. Pure frontend work.

**UI wireframe:**
```
+----------------------------------------------------------+
| Memory Review                           [Project: v]     |
|                                                          |
| Pending: 23  |  Threshold: 0.62  |  Promoted today: 5   |
|                                                          |
| [Select All] [Promote Selected] [Reject Selected]       |
|                                                          |
| +------------------------------------------------------+|
| | [x] "Redis cache TTL should be 300s for embeddings"  ||
| |     Type: insight  Score: 0.71  Source: auto_convo    ||
| |     Tags: redis, cache, performance                  ||
| |     Created: 2h ago                                  ||
| |     [Edit] [Promote] [Reject] [View Related]         ||
| +------------------------------------------------------+|
| | [ ] "Use p-limit for concurrent file processing"     ||
| |     Type: pattern  Score: 0.45  Source: auto_pattern  ||
| |     ...                                              ||
| +------------------------------------------------------+|
```

---

### 1d. Real-Time File Watching (Incremental Indexing)

**Description:** Currently, indexing is triggered manually via `POST /api/index` or `reka index`. For a product, codebases should stay indexed automatically as files change.

**Files/services affected:**
- `rag-api/src/services/file-watcher.ts` — new service using `chokidar` or Node.js `fs.watch`
- `rag-api/src/services/indexer.ts` — add `indexSingleFile()` and `removeFile()` methods (partial re-index)
- `rag-api/src/services/graph-store.ts` — update graph edges on file change
- `rag-api/src/services/symbol-index.ts` — update symbol index incrementally
- `rag-api/src/routes/index.ts` — add `/api/watch/start`, `/api/watch/stop`, `/api/watch/status`
- `rag-api/src/config.ts` — add `FILE_WATCH_ENABLED`, `FILE_WATCH_DEBOUNCE_MS`

**Effort:** 6 dev-days

**Dependencies:** None

**Acceptance criteria:**
- File watcher monitors project directories registered via `POST /api/watch/start`
- File changes are debounced (default 2s) and batched
- Only changed files are re-embedded and upserted (delta indexing)
- Deleted files have their vectors removed from Qdrant
- Renamed files update the `file` payload field without re-embedding (if content unchanged)
- Graph edges and symbol index are updated incrementally
- `.gitignore` patterns are respected
- Watcher survives file system errors gracefully (EMFILE, permission denied)
- Dashboard shows watcher status (active/paused, files watched, last update)
- Memory usage stays bounded (no unbounded event queues)

**Risk:** High. File watching is notoriously problematic: platform differences (inotify limits on Linux, FSEvents on macOS), symlink handling, large repos (100K+ files). `chokidar` v4 is recommended. Must handle the case where the watcher process restarts and needs to diff against the indexed state.

```typescript
// rag-api/src/services/file-watcher.ts
import { watch, type FSWatcher } from 'chokidar';

class FileWatcherService {
  private watchers = new Map<string, FSWatcher>(); // projectName -> watcher
  private pendingChanges = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  async startWatching(projectName: string, projectPath: string): Promise<void> {
    if (this.watchers.has(projectName)) return;

    const watcher = watch(projectPath, {
      ignored: [/node_modules/, /\.git/, /dist\//, /\.next\//],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    watcher.on('all', (event, filePath) => {
      this.queueChange(projectName, filePath, event as any);
    });

    this.watchers.set(projectName, watcher);
  }

  private queueChange(project: string, file: string, event: 'add' | 'change' | 'unlink') {
    if (!this.pendingChanges.has(project)) {
      this.pendingChanges.set(project, new Map());
    }
    this.pendingChanges.get(project)!.set(file, event);
    this.debouncedFlush(project);
  }

  private debouncedFlush(project: string) {
    const existing = this.debounceTimers.get(project);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(project, setTimeout(() => this.flush(project), 2000));
  }

  private async flush(project: string) {
    const changes = this.pendingChanges.get(project);
    if (!changes || changes.size === 0) return;
    const batch = new Map(changes);
    changes.clear();
    // Process: re-index added/changed, remove unlinked
    await indexer.processIncrementalChanges(project, batch);
  }
}
```

---

### 1e. Onboarding Flow (First-Time Setup Wizard)

**Description:** A guided experience for new users, both in the dashboard and CLI. Detects system capabilities, configures providers, creates the first project.

**Files/services affected:**
- `dashboard/src/pages/OnboardingPage.vue` — new multi-step wizard page
- `dashboard/src/stores/app.ts` — add `isFirstRun` state
- `rag-api/src/routes/setup.ts` — new routes for system detection
- `cli/src/commands/init.ts` — interactive CLI setup

**Effort:** 5 dev-days

**Dependencies:** 1b (CLI tool), 1i (health check endpoint)

**Acceptance criteria:**
- First visit to dashboard (no projects exist) redirects to onboarding
- Wizard steps: (1) System check, (2) LLM provider selection, (3) Embedding provider selection, (4) Create first project, (5) Index first codebase
- System check detects: Docker running, GPU available (nvidia-smi), ports available, disk space
- LLM provider options: Ollama (local, free), OpenAI API, Anthropic API — with validation (test API call)
- Embedding provider: BGE-M3 (recommended, local), OpenAI, Ollama
- Project creation: name, path, optional .gitignore integration
- After onboarding, generates `.env` file and starts services
- CLI `reka init` provides the same flow in terminal (using `inquirer` prompts)
- Onboarding state persisted so it is not shown again

**Risk:** Medium. GPU detection is unreliable across platforms. Must handle partial setups gracefully.

---

### 1f. Error Handling & User-Facing Error Messages

**Description:** The current error system (`rag-api/src/utils/errors.ts`) is developer-facing. Error messages like `"ECONNREFUSED"` or `"EXTERNAL_SERVICE_ERROR"` mean nothing to end users. Need human-readable messages and recovery suggestions.

**Files/services affected:**
- `rag-api/src/utils/errors.ts` — add `userMessage` and `suggestion` fields to `AppError`
- `rag-api/src/middleware/error-handler.ts` — map error codes to user-friendly messages
- `rag-api/src/utils/error-catalog.ts` — new file, central error message catalog
- `dashboard/src/composables/useErrorHandler.ts` — new composable for consistent error display

**Effort:** 4 dev-days

**Dependencies:** None

**Acceptance criteria:**
- Every error response includes `userMessage` (plain English) and `suggestion` (what to do)
- Error catalog covers all known failure modes (at least 30 entries)
- Dashboard shows toast notifications with user-friendly messages
- Connection failures show "Cannot reach [service]. Is Docker running?" instead of ECONNREFUSED
- Rate limit errors show "Slow down" with countdown timer
- Validation errors show which field is wrong and what is expected
- 500 errors show a generic message + request ID for support

**Risk:** Low.

```typescript
// rag-api/src/utils/error-catalog.ts
export const ERROR_CATALOG: Record<string, { userMessage: string; suggestion: string }> = {
  ECONNREFUSED_qdrant: {
    userMessage: 'Cannot connect to the vector database.',
    suggestion: 'Run "reka doctor" or check that Qdrant is running on port 6333.',
  },
  ECONNREFUSED_ollama: {
    userMessage: 'Cannot connect to the LLM service.',
    suggestion: 'Run "reka doctor" or check that Ollama is running on port 11434.',
  },
  ECONNREFUSED_bge: {
    userMessage: 'Cannot connect to the embedding service.',
    suggestion: 'Run "reka doctor" or check that BGE-M3 is running on port 8080.',
  },
  RATE_LIMIT: {
    userMessage: 'Too many requests. Please wait before trying again.',
    suggestion: 'Wait {retryAfter} seconds, or upgrade your rate limit tier.',
  },
  VALIDATION_ERROR: {
    userMessage: 'Invalid input provided.',
    suggestion: 'Check the request parameters and try again.',
  },
  TIMEOUT: {
    userMessage: 'The operation took too long.',
    suggestion: 'Try a simpler query, or check service health with "reka status".',
  },
  COLLECTION_NOT_FOUND: {
    userMessage: 'This project has not been indexed yet.',
    suggestion: 'Run "reka index" to index your codebase first.',
  },
  AUTH_REQUIRED: {
    userMessage: 'Authentication is required.',
    suggestion: 'Provide an API key via X-API-Key header or log in to the dashboard.',
  },
};
```

---

### 1g. Data Export/Backup Functionality

**Description:** Users need to export their data (memories, indexed codebase, configuration) and restore from backups. Qdrant already supports snapshots (`rag-api/src/routes/index.ts` lines 499-530), but there is no unified backup/restore across all collections and config.

**Files/services affected:**
- `rag-api/src/services/backup.ts` — new service orchestrating full backup
- `rag-api/src/routes/backup.ts` — new routes: `/api/backup`, `/api/restore`, `/api/backup/list`
- `rag-api/src/services/vector-store.ts` — already has `createSnapshot()`, `listSnapshots()`
- `cli/src/commands/backup.ts` — CLI backup/restore commands

**Effort:** 5 dev-days

**Dependencies:** 1b (CLI tool, for `reka backup` command)

**Acceptance criteria:**
- `POST /api/backup` creates snapshots of all collections for a project + exports config as JSON
- `GET /api/backup/list` lists available backups with timestamps and sizes
- `POST /api/restore` restores from a named backup
- Backup includes: all Qdrant collections, memory governance state, session data
- Export format: `.reka-backup.tar.gz` containing Qdrant snapshots + `metadata.json`
- CLI: `reka backup create`, `reka backup list`, `reka backup restore <name>`
- Backup integrity verification (checksum)
- Automatic daily backup option (`BACKUP_SCHEDULE=daily`)

**Risk:** Medium. Qdrant snapshot restoration requires stopping writes. Large backups (10GB+ for big codebases) need streaming.

---

### 1h. Configuration Simplification

**Description:** The current `config.ts` has 50+ settings (lines 8-110 of `rag-api/src/config.ts`). Most users should not need to set any of them. Need sane defaults, auto-detection, and a minimal `.env` file.

**Files/services affected:**
- `rag-api/src/config.ts` — add auto-detection logic, reduce required env vars to 0
- `rag-api/src/services/auto-detect.ts` — new service to detect available providers
- `cli/src/commands/config.ts` — `reka config` command
- New file: `reka.config.ts` format (see Section 3)

**Effort:** 4 dev-days

**Dependencies:** None

**Acceptance criteria:**
- Zero-config startup: `reka init && reka start` works with no `.env` file
- Auto-detect: if Ollama is running, use it for LLM; if BGE-M3 is running, use it for embeddings; otherwise fall back to OpenAI
- Minimal config file (`reka.config.ts`) replaces `.env` for persistent settings
- `reka config show` displays current effective config with source of each value (default/env/file/auto-detected)
- `reka config set llm.provider openai` updates config file
- Sensitive values (API keys) stay in env vars, never in config file
- Config validation at startup with actionable error messages

**Risk:** Low.

```typescript
// rag-api/src/services/auto-detect.ts
export async function detectProviders(): Promise<DetectedConfig> {
  const checks = await Promise.allSettled([
    fetch('http://localhost:11434/api/tags').then(r => r.ok),  // Ollama
    fetch('http://localhost:8080/health').then(r => r.ok),     // BGE-M3
    fetch('http://localhost:6333/healthz').then(r => r.ok),    // Qdrant
  ]);

  return {
    llmProvider: checks[0].status === 'fulfilled' && checks[0].value ? 'ollama' : 'anthropic',
    embeddingProvider: checks[1].status === 'fulfilled' && checks[1].value ? 'bge-m3-server' : 'openai',
    qdrantAvailable: checks[2].status === 'fulfilled' && checks[2].value,
  };
}
```

---

### 1i. Health Check Dashboard Endpoint

**Description:** The current `/health` endpoint (server.ts line 80) returns basic status + cache stats. Need a comprehensive health check that tests every dependency and returns structured results.

**Files/services affected:**
- `rag-api/src/server.ts` — expand `/health` endpoint
- `rag-api/src/services/health.ts` — new service with per-dependency checks
- `dashboard/src/pages/OverviewPage.vue` — show health status cards
- `cli/src/commands/status.ts` — `reka status` uses this endpoint

**Effort:** 2 dev-days

**Dependencies:** None

**Acceptance criteria:**
- `GET /health` returns status of each dependency: Qdrant, Ollama, BGE-M3, Redis
- Each check includes: status (up/down/degraded), latency, version, last error
- Overall status: "healthy" (all up), "degraded" (some down), "unhealthy" (critical down)
- Response time < 5s even if dependencies are down (use timeouts)
- Dashboard overview page shows green/yellow/red indicators per service
- CLI `reka status` shows a formatted table

**Risk:** Low.

```typescript
// rag-api/src/services/health.ts
interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  checks: {
    qdrant: { status: 'up' | 'down'; latencyMs: number; version?: string; vectorCount?: number };
    ollama: { status: 'up' | 'down'; latencyMs: number; model?: string };
    bgeM3:  { status: 'up' | 'down'; latencyMs: number };
    redis:  { status: 'up' | 'down'; latencyMs: number; memoryUsed?: string };
  };
  projects: { name: string; collections: number; totalVectors: number }[];
}
```

---

### 1j. Rate Limiting Improvements

**Description:** Current rate limiting (`rag-api/src/middleware/rate-limit.ts`) is in-memory per-IP with 3 tiers. Needs to be Redis-backed (survives restarts), per-API-key, and configurable per-project.

**Files/services affected:**
- `rag-api/src/middleware/rate-limit.ts` — refactor to use Redis sliding window
- `rag-api/src/services/cache.ts` — add rate limit helper methods
- `rag-api/src/config.ts` — add per-tier config

**Effort:** 3 dev-days

**Dependencies:** 1a (Auth — needed for per-key limiting)

**Acceptance criteria:**
- Rate limits stored in Redis (key: `ratelimit:{tier}:{identifier}`)
- Identifier is API key ID (if authenticated) or IP address (fallback)
- Limits survive API restarts
- Admin can override limits per API key
- Rate limit headers (`X-RateLimit-*`) already present (keep them)
- Graceful fallback to in-memory if Redis is unavailable
- Dashboard shows rate limit usage per API key

**Risk:** Low. The current implementation is solid; this is mostly swapping the storage backend.

---

### MVP Summary Table

| Task | Effort | Dependencies | Risk | Priority |
|------|--------|-------------|------|----------|
| 1a. Auth & AuthZ | 8d | None | Medium | P0 |
| 1b. CLI Tool | 12d | 1i | Medium | P0 |
| 1c. Memory Review UI | 5d | None | Low | P0 |
| 1d. File Watching | 6d | None | High | P1 |
| 1e. Onboarding Flow | 5d | 1b, 1i | Medium | P0 |
| 1f. Error Handling | 4d | None | Low | P0 |
| 1g. Data Export/Backup | 5d | 1b | Medium | P1 |
| 1h. Config Simplification | 4d | None | Low | P0 |
| 1i. Health Check | 2d | None | Low | P0 |
| 1j. Rate Limit Improvements | 3d | 1a | Low | P1 |
| **Total** | **54d** | | | |

**Critical path:** 1i (2d) -> 1b (12d) -> 1e (5d) = 19 days. Parallelize: 1a, 1c, 1f, 1h, 1d run concurrently.

---

## 2. Post-MVP Enhancements

### 2a. Tree-sitter Integration

**Business value:** Current code graph uses regex-based parsing (~80% accuracy per project docs). Tree-sitter provides 99%+ accurate AST parsing, enabling precise symbol extraction, import resolution, and type analysis. This is the difference between a toy and a professional tool.

**Technical approach:**
- Use `tree-sitter` npm package with language-specific grammar packages (`tree-sitter-typescript`, `tree-sitter-python`, etc.)
- Replace regex patterns in `rag-api/src/services/parsers/code-parser.ts` (477 lines) and `rag-api/src/services/parsers/ast-parser.ts` (247 lines)
- Build a `TreeSitterParser` implementing the existing `FileParser` interface from `rag-api/src/services/parsers/base-parser.ts`
- Feed AST nodes into `graph-store.ts` for precise import/export edges
- Feed symbol definitions into `symbol-index.ts` for exact function/class/type positions

**Effort:** 10 dev-days

**Priority:** P1

---

### 2b. GitHub/GitLab Webhook Integration

**Business value:** Automatic re-indexing on push. Teams using Reka across repos need their index to stay current without manual intervention.

**Technical approach:**
- Add `rag-api/src/routes/webhooks.ts` with endpoints for GitHub (`push`, `pull_request`) and GitLab (`push_events`, `merge_request_events`) webhooks
- Webhook signature verification (HMAC-SHA256 for GitHub, token for GitLab)
- On push: identify changed files from webhook payload, trigger incremental re-index (depends on 1d)
- On PR: optionally trigger automated review (depends on 2c)
- Store webhook secrets per project in config

**Effort:** 5 dev-days

**Priority:** P1

---

### 2c. PR Review Automation

**Business value:** Automated code review using RAG context. Reviews are architecture-aware because they can reference the project's existing patterns, ADRs, and memory.

**Technical approach:**
- `rag-api/src/routes/review.ts` already exists with review endpoints
- Add GitHub API integration: post review comments via `@octokit/rest`
- PR diff parsing: extract changed files, map to existing graph for blast radius
- Review pipeline: (1) get diff, (2) context_briefing on affected files, (3) recall relevant ADRs/patterns, (4) LLM review with full context, (5) post inline comments
- GitHub App or OAuth for authentication

**Effort:** 8 dev-days

**Priority:** P2

---

### 2d. Cross-Project Memory Sharing

**Business value:** Teams working on microservices share architectural decisions. An ADR recorded in project A should be discoverable from project B when relevant.

**Technical approach:**
- Add `shared_memory` collection in Qdrant (not project-namespaced)
- Memory metadata includes `sourceProject` and `sharedWith: string[]`
- `recall()` searches both project-specific and shared collections, merges results
- Governance: only durable (promoted) memories can be shared
- Dashboard: toggle "Share with all projects" when promoting a memory
- API: `POST /api/memory/:id/share` with `targetProjects` parameter

**Effort:** 5 dev-days

**Priority:** P2

---

### 2e. Multi-Tenant SaaS Mode

**Business value:** Hosting Reka as a service for multiple teams/organizations. Each tenant gets isolated data, billing, and admin.

**Technical approach:**
- Tenant isolation at the Qdrant collection level: `{tenant}_{project}_codebase`
- Tenant middleware extracts tenant from subdomain or JWT claims
- Per-tenant rate limits, storage quotas, and API key management
- Billing integration: track embeddings generated, LLM tokens used (cost-tracker.ts already exists)
- Admin dashboard: tenant management, usage metrics, billing
- Data residency: tenant config specifies Qdrant cluster (for geo requirements)

**Effort:** 20 dev-days

**Priority:** P3

---

### 2f. VS Code Extension

**Business value:** IDE integration is where developers spend their time. Search, memory, and code context without leaving the editor.

**Technical approach:**
- VS Code extension using the Extension API
- TreeView panel for memory, search results, session info
- Commands: "Reka: Search", "Reka: Remember", "Reka: Recall", "Reka: Explain Selection"
- Communication via RAG API HTTP endpoints (same as CLI)
- CodeLens integration: show related code, blast radius on function definitions
- Status bar: connection status, active session, memory count

**Effort:** 12 dev-days

**Priority:** P2

---

### 2g. Streaming Responses

**Business value:** LLM responses (ask, explain, review) take 5-30 seconds. Streaming shows partial results immediately, dramatically improving perceived performance.

**Technical approach:**
- Add SSE (Server-Sent Events) variants of LLM endpoints: `/api/ask/stream`, `/api/review/stream`
- Ollama already supports streaming natively (`stream: true` in API)
- Anthropic SDK supports streaming via `client.messages.stream()`
- `rag-api/src/services/llm.ts` — add `completeStream()` method returning an AsyncIterable
- Dashboard: use `useSSE.ts` composable (already exists in `dashboard/src/composables/useSSE.ts`)
- MCP server: MCP protocol supports streaming via progress notifications

**Effort:** 5 dev-days

**Priority:** P1

---

### 2h. Multi-Language Support (Python, Go, Rust Parsers)

**Business value:** Reka currently handles TypeScript/JavaScript well. Polyglot teams need Python, Go, Rust, Java support at the same quality level.

**Technical approach:**
- Extend `ParserRegistry` in `rag-api/src/services/parsers/index.ts` with language-specific parsers
- Each parser implements `FileParser` interface: `canParse(file)`, `parse(content, filePath)`
- Python: parse imports (`import`, `from...import`), classes, functions, decorators
- Go: parse packages, imports, structs, interfaces, functions
- Rust: parse `use`, `mod`, `struct`, `impl`, `trait`, `fn`
- Java: parse packages, imports, classes, interfaces, methods, annotations
- If tree-sitter (2a) lands first, these are language grammar additions rather than custom parsers

**Effort:** 8 dev-days (with tree-sitter: 3 dev-days)

**Priority:** P2

---

### 2i. Scheduled Re-indexing (Cron)

**Business value:** For users who do not want file watching (1d), scheduled re-indexing ensures the index stays fresh without manual intervention.

**Technical approach:**
- Add `node-cron` dependency to rag-api
- `rag-api/src/services/scheduler.ts` — new service managing cron jobs per project
- Config: `REINDEX_SCHEDULE` (cron expression, default: none / disabled)
- Per-project schedule stored in project config
- Smart re-index: hash file contents, skip unchanged files (already partially implemented in indexer.ts via content hashing)
- Dashboard: schedule management UI in Settings page

**Effort:** 3 dev-days

**Priority:** P2

---

### 2j. Plugin System for Custom Tools

**Business value:** Let users extend Reka with custom MCP tools, custom parsers, custom memory processors without forking the codebase.

**Technical approach:**
- Plugin interface: `RekaPlugin { name: string; version: string; tools?: McpTool[]; parsers?: FileParser[]; hooks?: PluginHooks }`
- Plugin loading: scan `~/.reka/plugins/` and project-local `.reka/plugins/` directories
- Each plugin is an npm package exporting a `RekaPlugin` object
- Hook system: `beforeIndex`, `afterIndex`, `beforeMemoryStore`, `afterSearch`, etc.
- Plugin registry in dashboard settings
- CLI: `reka plugin install <name>`, `reka plugin list`, `reka plugin remove <name>`

**Effort:** 10 dev-days

**Priority:** P3

---

### Post-MVP Priority Summary

| Feature | Effort | Priority | Depends On |
|---------|--------|----------|-----------|
| 2g. Streaming Responses | 5d | P1 | None |
| 2a. Tree-sitter | 10d | P1 | None |
| 2b. GitHub Webhooks | 5d | P1 | 1d |
| 2h. Multi-Language Parsers | 3-8d | P2 | 2a (optional) |
| 2c. PR Review Automation | 8d | P2 | 2b |
| 2d. Cross-Project Memory | 5d | P2 | None |
| 2f. VS Code Extension | 12d | P2 | None |
| 2i. Scheduled Re-indexing | 3d | P2 | None |
| 2e. Multi-Tenant SaaS | 20d | P3 | 1a |
| 2j. Plugin System | 10d | P3 | None |

---

## 3. CLI Tool Design (`reka` command)

### Full Command Tree

```
reka
├── init                     # Interactive project setup
├── start                    # Start all services (Docker Compose up)
├── stop                     # Stop all services
├── restart                  # Restart services
├── status                   # Show service health + project stats
├── doctor                   # Diagnose problems
│
├── index                    # Index current project
│   ├── --path <dir>         # Project path (default: cwd)
│   ├── --force              # Re-index all files
│   ├── --watch              # Start file watcher after indexing
│   └── --exclude <pattern>  # Glob pattern to exclude
│
├── search <query>           # Semantic search
│   ├── --project <name>     # Project name (default: auto-detect from cwd)
│   ├── --limit <n>          # Max results (default: 5)
│   ├── --json               # Output as JSON
│   └── --mode <content|navigate>  # Search mode
│
├── ask <question>           # Ask a question about the codebase
│   ├── --project <name>
│   └── --stream             # Stream response
│
├── memory
│   ├── add <content>        # Store a memory
│   │   ├── --type <type>    # insight|decision|pattern|adr|tech_debt
│   │   └── --tags <t1,t2>   # Comma-separated tags
│   ├── recall <query>       # Search memories
│   ├── list                 # List recent memories
│   ├── review               # Review quarantined memories (interactive)
│   ├── promote <id>         # Promote from quarantine
│   ├── reject <id>          # Reject from quarantine
│   └── export               # Export all memories as JSON
│
├── config
│   ├── show                 # Show effective configuration
│   ├── set <key> <value>    # Set a config value
│   ├── get <key>            # Get a config value
│   └── reset                # Reset to defaults
│
├── backup
│   ├── create               # Create full backup
│   │   └── --output <path>  # Output file path
│   ├── list                 # List available backups
│   └── restore <name>       # Restore from backup
│
├── project
│   ├── list                 # List all projects
│   ├── create <name>        # Create a new project
│   ├── delete <name>        # Delete project and all data
│   └── stats <name>         # Show project statistics
│
├── mcp
│   ├── config               # Generate MCP config for current project
│   └── test                 # Test MCP server connection
│
├── plugin
│   ├── install <name>       # Install a plugin
│   ├── list                 # List installed plugins
│   └── remove <name>        # Remove a plugin
│
├── upgrade                  # Upgrade Reka to latest version
├── logs                     # Tail service logs
│   └── --service <name>     # Filter by service (rag-api|qdrant|ollama|bge-m3|redis)
│
└── version                  # Show version
```

### Arguments and Flags

Global flags (available on all commands):
```
--verbose, -v          # Show debug output
--quiet, -q            # Suppress non-essential output
--json                 # Output as JSON (for scripting)
--project, -p <name>   # Override project name
--api-url <url>        # Override RAG API URL (default: http://localhost:3100)
--api-key <key>        # API key for authentication
```

### Output Format Examples

```bash
$ reka status
  Reka v1.0.0

  Services
  ────────────────────────────────────────
  Qdrant     ● running   v1.12.6   6333   142ms
  Ollama     ● running   0.5.4     11434   89ms    qwen3.5:35b loaded
  BGE-M3     ● running   -         8080    34ms
  Redis      ● running   7.2.4     6380    2ms     412MB/512MB
  RAG API    ● running   1.2.0     3100    8ms

  Projects
  ────────────────────────────────────────
  myproject    12 collections   45,231 vectors   Last indexed: 2h ago
  other-proj    8 collections   12,882 vectors   Last indexed: 1d ago

$ reka search "authentication middleware"
  Results for "authentication middleware" in myproject

  1. src/middleware/auth.ts (0.89)
     API Key Authentication Middleware — validates requests against API_KEY...

  2. src/routes/auth.ts (0.82)
     Authentication routes — login, register, token refresh...

  3. src/services/auth.ts (0.78)
     Auth service — user management, API key CRUD...

$ reka memory recall "caching strategy"
  Memories matching "caching strategy"

  1. [insight] Redis cache TTL should be 300s for embeddings (0.91)
     Tags: redis, cache, performance
     Status: durable | Created: 3d ago | Recalled: 5 times

  2. [decision] Use allkeys-lru eviction policy (0.85)
     Tags: redis, cache
     Status: durable | Created: 1w ago | Recalled: 2 times
```

### Configuration File Format

```typescript
// reka.config.ts
import { defineConfig } from 'reka';

export default defineConfig({
  // Project defaults
  project: {
    name: 'myproject',
    path: '.',
    exclude: ['node_modules', 'dist', '.git', '*.test.ts'],
  },

  // LLM provider
  llm: {
    provider: 'ollama',           // 'ollama' | 'openai' | 'anthropic'
    model: 'qwen3.5:35b',        // auto-detected if not set
  },

  // Embedding provider
  embedding: {
    provider: 'bge-m3-server',   // 'bge-m3-server' | 'ollama' | 'openai'
  },

  // Services (override defaults only if needed)
  services: {
    qdrant: { url: 'http://localhost:6333' },
    ollama: { url: 'http://localhost:11434' },
    bgeM3:  { url: 'http://localhost:8080' },
    redis:  { url: 'redis://localhost:6380' },
  },

  // File watching
  watch: {
    enabled: true,
    debounceMs: 2000,
    ignore: ['**/*.log', '**/tmp/**'],
  },

  // Memory governance
  memory: {
    quarantineTtlDays: 7,
    autoConsolidation: true,
  },

  // Indexing
  index: {
    schedule: '0 2 * * *',       // cron: 2 AM daily (optional)
    fileConcurrency: 5,
    embedConcurrency: 3,
  },
});
```

Alternative: `.rekarc` (JSON format for users who prefer simplicity):
```json
{
  "project": "myproject",
  "llm": "ollama",
  "embedding": "bge-m3-server"
}
```

### How CLI Communicates with RAG API

The CLI is a thin HTTP client. It does not embed any business logic.

```
CLI (reka) --> HTTP --> RAG API (:3100) --> Qdrant/Ollama/BGE-M3/Redis
```

- All commands translate to one or more HTTP calls to the RAG API
- Authentication: API key sent via `X-API-Key` header
- Project identification: `X-Project-Name` header + `projectName` in body
- Streaming: SSE for long-running operations (index progress, LLM responses)
- Config file (`reka.config.ts`) is read client-side by the CLI, values are sent as request parameters
- The CLI does NOT start Docker containers directly; `reka start` invokes `docker compose` on the bundled `docker-compose.yml`

```typescript
// cli/src/lib/client.ts
import axios, { AxiosInstance } from 'axios';

export function createClient(config: CliConfig): AxiosInstance {
  return axios.create({
    baseURL: config.apiUrl || 'http://localhost:3100',
    headers: {
      'X-API-Key': config.apiKey || process.env.REKA_API_KEY,
      'X-Project-Name': config.project,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
}
```

---

## 4. Installer Script Design

### What the Install Script Does (Step by Step)

```bash
curl -fsSL https://reka.dev/install | bash
```

The script performs these steps in order:

1. **Banner & consent**
   ```
   ╔══════════════════════════════════════╗
   ║  Reka Installer v1.0                ║
   ║  AI-powered code intelligence       ║
   ╚══════════════════════════════════════╝
   This will install Reka and its dependencies.
   Continue? [Y/n]
   ```

2. **System requirements check**
   ```bash
   # Required
   check_command "docker" "24.0+" "https://docs.docker.com/get-docker/"
   check_command "docker compose" "2.20+" "(bundled with Docker Desktop)"
   check_command "node" "18+" "https://nodejs.org/"
   check_command "npm" "9+" "(bundled with Node.js)"
   check_disk_space "/var/lib/docker" "10GB"  # For images + volumes
   check_memory "8GB"                          # Minimum RAM

   # Optional
   check_command "git" "any" "(needed for repo indexing)"
   check_gpu                                   # NVIDIA GPU for Ollama
   ```

3. **Port conflict resolution**
   ```bash
   PORTS=(3100 6333 6334 8080 11434 6380)
   for port in "${PORTS[@]}"; do
     if lsof -i ":$port" >/dev/null 2>&1; then
       PID=$(lsof -t -i ":$port")
       PROCESS=$(ps -p "$PID" -o comm=)
       echo "⚠ Port $port in use by $PROCESS (PID $PID)"
       echo "  Options: [K]ill process, [S]kip (use alternate port), [A]bort"
       read -r choice
       case $choice in
         K|k) kill "$PID" ;;
         S|s) REMAP_PORT[$port]=$((port + 1000)) ;;  # e.g., 3100 -> 4100
         *)   exit 1 ;;
       esac
     fi
   done
   ```

4. **Installation path selection**
   ```bash
   # Choose between Docker (recommended) and native
   echo "Installation type:"
   echo "  [1] Docker (recommended) — all services in containers"
   echo "  [2] Native — install Ollama and Qdrant directly"
   read -r install_type
   ```

5. **GPU detection for Ollama**
   ```bash
   detect_gpu() {
     if command -v nvidia-smi &>/dev/null; then
       GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null)
       if [ -n "$GPU_INFO" ]; then
         echo "GPU detected: $GPU_INFO"
         echo "Ollama will use GPU acceleration."
         export OLLAMA_GPU=true
         # Check nvidia-container-toolkit for Docker
         if ! docker info 2>/dev/null | grep -q "nvidia"; then
           echo "Warning: nvidia-container-toolkit not installed."
           echo "Install it: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
           echo "Falling back to CPU mode for Ollama."
           export OLLAMA_GPU=false
         fi
       fi
     elif [ -d "/opt/rocm" ]; then
       echo "AMD ROCm detected. Ollama may support ROCm in Docker."
       export OLLAMA_GPU=rocm
     elif [[ "$(uname)" == "Darwin" ]] && sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -q "Apple"; then
       echo "Apple Silicon detected. Native Ollama will use Metal acceleration."
       export OLLAMA_GPU=metal
     else
       echo "No GPU detected. Ollama will run in CPU mode (slower)."
       export OLLAMA_GPU=false
     fi
   }
   ```

6. **Install CLI tool**
   ```bash
   npm install -g reka
   ```

7. **Pull Docker images / Generate docker-compose.yml**
   ```bash
   REKA_DIR="$HOME/.reka"
   mkdir -p "$REKA_DIR"

   # Generate docker-compose.yml with detected configuration
   cat > "$REKA_DIR/docker-compose.yml" << EOF
   version: '3.8'
   services:
     qdrant:
       image: qdrant/qdrant:v1.12.6
       ports: ["${QDRANT_PORT:-6333}:6333"]
       volumes: [reka_qdrant:/qdrant/storage]
       # ... (full compose file, templated with detected ports/GPU config)
   EOF

   # Pull images (with progress)
   docker compose -f "$REKA_DIR/docker-compose.yml" pull
   ```

8. **Start services**
   ```bash
   docker compose -f "$REKA_DIR/docker-compose.yml" up -d
   echo "Waiting for services to be ready..."
   reka doctor --wait --timeout 120
   ```

9. **Pull/verify LLM model**
   ```bash
   # Pull default model if Ollama is the LLM provider
   if [ "$OLLAMA_GPU" != "false" ] || [ "$INSTALL_TYPE" = "docker" ]; then
     echo "Pulling LLM model (this may take a few minutes)..."
     curl -s http://localhost:11434/api/pull -d '{"name":"qwen3.5:35b"}' | \
       while IFS= read -r line; do
         STATUS=$(echo "$line" | jq -r '.status // empty')
         [ -n "$STATUS" ] && printf "\r  %s" "$STATUS"
       done
     echo ""
   fi
   ```

10. **Post-install verification**
    ```bash
    echo "Running post-install checks..."
    reka doctor

    # Expected output:
    #   ✓ Docker is running
    #   ✓ Qdrant is healthy (v1.12.6)
    #   ✓ Ollama is healthy (qwen3.5:35b loaded)
    #   ✓ BGE-M3 is healthy
    #   ✓ Redis is healthy
    #   ✓ RAG API is healthy (v1.2.0)
    #   ✓ All ports are accessible
    #
    #   Reka is ready! Run "reka init" to set up your first project.
    ```

### Docker vs Native Installation Paths

**Docker path (recommended):**
- All 5 services run in containers via `docker compose`
- GPU passthrough via `nvidia-container-toolkit`
- Volumes for data persistence (`reka_qdrant`, `reka_ollama`, etc.)
- Upgrade: `docker compose pull && docker compose up -d`

**Native path (advanced):**
- Qdrant: download binary or `cargo install`
- Ollama: `curl -fsSL https://ollama.ai/install.sh | bash`
- BGE-M3: `pip install flagembedding && python -m bge_m3_server`
- Redis: `apt install redis-server` or `brew install redis`
- RAG API: `npm install -g @reka/api && reka-api start`
- More performant (no container overhead) but harder to manage

---

## 5. Testing Strategy for Launch

### What Needs to Be Tested Before Launch

**Current state:** 776 tests, 47 suites, 2 failing. Coverage at ~54%. This is insufficient for a product launch.

### Unit Test Coverage Targets

| Area | Current | Target | Gap |
|------|---------|--------|-----|
| Services (core logic) | ~60% | 85% | auth.ts, backup.ts, file-watcher.ts, health.ts, auto-detect.ts |
| Routes (API endpoints) | ~40% | 80% | All new routes (auth, backup, webhooks) |
| Middleware | ~50% | 90% | Rate limit Redis backend, auth JWT flow |
| Utils | ~70% | 90% | Error catalog, config validation |
| CLI commands | 0% | 75% | All commands |
| Dashboard stores | 0% | 60% | Critical stores (auth, memory) |

### Integration Test Plan

```typescript
// rag-api/src/__tests__/integration/

// 1. Full indexing pipeline
describe('Indexing Pipeline', () => {
  it('indexes a TypeScript project end-to-end');
  it('handles incremental re-indexing');
  it('respects .gitignore');
  it('handles binary files gracefully');
  it('handles empty files');
  it('handles files > 1MB');
  it('handles 10K+ files without OOM');
});

// 2. Search accuracy
describe('Search Quality', () => {
  it('returns relevant results for function name queries');
  it('returns relevant results for conceptual queries');
  it('filters by language correctly');
  it('handles multi-project isolation (no cross-contamination)');
});

// 3. Memory lifecycle
describe('Memory Governance', () => {
  it('auto-memories go to quarantine');
  it('manual memories go to durable');
  it('promote moves from quarantine to durable');
  it('reject removes from quarantine');
  it('adaptive threshold adjusts based on history');
  it('consolidation merges related memories');
});

// 4. Auth flows
describe('Authentication', () => {
  it('rejects requests without auth when API_KEY is set');
  it('accepts valid Bearer token');
  it('accepts valid X-API-Key');
  it('enforces project-level permissions');
  it('rate limits per API key');
  it('JWT expiry and refresh works');
});

// 5. Service resilience
describe('Resilience', () => {
  it('handles Qdrant being down');
  it('handles Ollama being down');
  it('handles Redis being down');
  it('recovers after service restart');
  it('circuit breaker opens after repeated failures');
  it('circuit breaker closes after recovery');
});
```

### Performance Benchmarks

Run before every release:

| Benchmark | Target | How to Measure |
|-----------|--------|----------------|
| Indexing speed | 1000 files/min (TypeScript) | Index the rag-api source (300+ files), measure wall time |
| Search latency (p50) | < 200ms | 100 random queries against 50K vector collection |
| Search latency (p99) | < 1s | Same as above |
| Memory recall latency | < 150ms | 100 recall queries against 1K memory collection |
| LLM ask latency (p50) | < 5s (Ollama) | 20 "ask" queries, measure time to first token |
| Concurrent users | 50 simultaneous | k6 or Artillery load test, 50 VUs, 5 min duration |
| Memory usage (idle) | < 500MB RSS | Monitor with `process.memoryUsage()` after 1h idle |
| Memory usage (indexing) | < 2GB RSS | Monitor during 10K file index |
| Startup time | < 10s to healthy | Measure from `reka start` to `GET /health` returning 200 |

```bash
# Performance test with k6
k6 run --vus 50 --duration 5m tests/load/search.js
k6 run --vus 10 --duration 5m tests/load/ask.js
k6 run --vus 5 --duration 5m tests/load/index.js
```

### Security Audit Checklist

- [ ] **Dependency scan:** `npm audit` on all 3 packages (rag-api, mcp-server, cli)
- [ ] **SAST:** Run `eslint-plugin-security` rules on all TypeScript
- [ ] **API key entropy:** Verify generated API keys have >= 256 bits of entropy
- [ ] **JWT security:** Verify HS256 with strong secret (>= 32 bytes), expiry <= 24h
- [ ] **Password hashing:** Verify bcrypt with cost factor >= 12
- [ ] **SQL/NoSQL injection:** Verify all Qdrant filter values are parameterized (they are, via the SDK)
- [ ] **Path traversal:** Verify `projectPath` in indexing cannot escape intended directory
- [ ] **CORS:** Verify CORS is restricted (currently `cors()` with no origin restriction)
- [ ] **Rate limiting:** Verify rate limits cannot be bypassed via `X-Forwarded-For` spoofing
- [ ] **Error leakage:** Verify 500 errors do not leak stack traces in production
- [ ] **Secrets in logs:** Verify API keys, passwords, tokens are never logged
- [ ] **Docker security:** Verify containers run as non-root, no privileged mode
- [ ] **Input validation:** Verify all Zod schemas have max length constraints (they do)
- [ ] **File upload:** Verify `/api/index/upload` validates file content size
- [ ] **SSRF:** Verify `QDRANT_URL`, `OLLAMA_URL`, etc. cannot be set to internal network addresses by untrusted users
- [ ] **Prototype pollution:** Verify `express.json()` does not allow `__proto__` keys (Express 4.x is safe)

### Load Testing Approach

```javascript
// tests/load/search.js (k6 script)
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 10 },   // ramp up
    { duration: '3m', target: 50 },   // sustained load
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],  // 95th percentile < 1s
    http_req_failed: ['rate<0.01'],     // Error rate < 1%
  },
};

const QUERIES = ['authentication middleware', 'database connection', 'error handling', /*...*/];
const API_URL = __ENV.API_URL || 'http://localhost:3100';

export default function () {
  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const res = http.post(`${API_URL}/api/search`, JSON.stringify({
    collection: 'myproject_codebase',
    query,
    limit: 5,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': __ENV.API_KEY,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has results': (r) => JSON.parse(r.body).results?.length > 0,
  });

  sleep(0.5);
}
```

---

## 6. Architecture Changes Needed

### What Needs to Change

#### 6.1 Package Restructure

Current:
```
shared-ai-infra/
├── rag-api/          # Backend (Express)
├── mcp-server/       # MCP tools
├── dashboard/        # Vue 3 frontend
└── docker/           # Docker Compose
```

Target:
```
reka/
├── packages/
│   ├── api/          # @reka/api — backend
│   ├── cli/          # @reka/cli — CLI tool
│   ├── mcp/          # @reka/mcp — MCP server
│   ├── dashboard/    # @reka/dashboard — web UI
│   └── shared/       # @reka/shared — shared types, utils
├── docker/           # Docker Compose files
├── install.sh        # Installer script
├── reka.config.ts    # Example config
└── package.json      # Workspace root (npm workspaces or turborepo)
```

Use npm workspaces for monorepo management. The `@reka/shared` package contains:
- TypeScript types shared between api, cli, mcp, dashboard
- Error codes and catalog
- Config schema (Zod)
- API client (used by cli, mcp, dashboard)

#### 6.2 Database Migrations

Qdrant does not have a traditional migration system. Collections are created on first use. However, payload schema changes need migration.

```typescript
// packages/api/src/migrations/index.ts
interface Migration {
  version: string;
  description: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

const migrations: Migration[] = [
  {
    version: '1.0.0',
    description: 'Add auth collections',
    up: async () => {
      await vectorStore.ensureCollection('_reka_users', { size: 1, distance: 'Cosine' });
      await vectorStore.ensureCollection('_reka_api_keys', { size: 1, distance: 'Cosine' });
      // These use Qdrant as a document store (vector is a dummy 1D vector)
    },
    down: async () => {
      await vectorStore.deleteCollection('_reka_users');
      await vectorStore.deleteCollection('_reka_api_keys');
    },
  },
  {
    version: '1.1.0',
    description: 'Add shared_memory collection',
    up: async () => {
      await vectorStore.ensureCollection('shared_memory');
    },
    down: async () => {
      await vectorStore.deleteCollection('shared_memory');
    },
  },
  {
    version: '1.2.0',
    description: 'Add backup metadata collection',
    up: async () => {
      await vectorStore.ensureCollection('_reka_backups', { size: 1, distance: 'Cosine' });
    },
    down: async () => {
      await vectorStore.deleteCollection('_reka_backups');
    },
  },
];

// Migration runner tracks applied migrations in `_reka_migrations` collection
class MigrationRunner {
  async getAppliedVersions(): Promise<string[]> { /* scroll _reka_migrations */ }
  async run(): Promise<void> {
    const applied = await this.getAppliedVersions();
    for (const m of migrations) {
      if (!applied.includes(m.version)) {
        logger.info(`Running migration ${m.version}: ${m.description}`);
        await m.up();
        await this.markApplied(m.version);
      }
    }
  }
}
```

#### 6.3 API Versioning Strategy

**Approach:** URL prefix versioning.

```typescript
// Current: /api/search
// v1:      /api/v1/search
// v2:      /api/v2/search (future)

// packages/api/src/server.ts
app.use('/api/v1', v1Routes);   // Versioned
app.use('/api', v1Routes);      // Unversioned = latest stable (backward compat)
```

**Version lifecycle:**
- v1: current API, supported for 12 months after v2 ships
- Breaking changes only in major versions
- Deprecation warnings via `X-Reka-Deprecation` response header

**Breaking changes in v1 (from current):**
1. All `collection` parameters renamed to `projectName` (the API does the collection naming internally). Current: `search({ collection: 'myproject_codebase', ... })`. New: `search({ projectName: 'myproject', ... })`.
2. `X-Project-Name` header becomes the primary way to specify project (not body `projectName`)
3. All response envelopes standardized: `{ data: T, meta: { requestId, duration } }`

**Migration path:**
- v1 API accepts both old and new parameter names for 6 months
- CLI and MCP server ship with v1 from day one
- Dashboard API client updated to v1

#### 6.4 Monitoring Additions

Current: 30+ Prometheus metrics. Add:

| Metric | Type | Description |
|--------|------|-------------|
| `reka_active_projects` | Gauge | Number of projects with indexed data |
| `reka_total_vectors` | Gauge | Total vectors across all collections |
| `reka_auth_attempts_total` | Counter | Auth attempts by result (success/failure/expired) |
| `reka_api_key_usage` | Counter | Requests per API key |
| `reka_memory_quarantine_size` | Gauge | Memories awaiting review per project |
| `reka_memory_promotions_total` | Counter | Memories promoted from quarantine |
| `reka_file_watcher_events` | Counter | File change events processed |
| `reka_backup_size_bytes` | Gauge | Last backup size per project |
| `reka_indexing_queue_depth` | Gauge | Files waiting to be indexed |

---

## 7. Security Hardening

### 7.1 Authentication Implementation Details

**JWT Implementation:**

```typescript
// packages/api/src/services/auth.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '24h';
const REFRESH_EXPIRY = '7d';
const API_KEY_BYTES = 32; // 256 bits

interface JwtPayload {
  userId: string;
  email: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}

class AuthService {
  async register(email: string, password: string): Promise<User> {
    // Validate password strength
    if (password.length < 12) throw new ValidationError('Password must be >= 12 characters');

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuidv4();

    // Store in _reka_users collection
    await vectorStore.upsert('_reka_users', [{
      id: userId,
      vector: [0], // dummy vector
      payload: { email, hashedPassword, role: 'user', createdAt: new Date().toISOString() },
    }]);

    return { id: userId, email, role: 'user' };
  }

  async login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.findUserByEmail(email);
    if (!user) throw new AppError('Invalid credentials', 'INVALID_CREDENTIALS', 401);

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) throw new AppError('Invalid credentials', 'INVALID_CREDENTIALS', 401);

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      config.JWT_SECRET,
      { expiresIn: REFRESH_EXPIRY }
    );

    return { accessToken, refreshToken };
  }

  async generateApiKey(userId: string, name: string, allowedProjects: string[]): Promise<string> {
    const rawKey = `reka_${randomBytes(API_KEY_BYTES).toString('hex')}`;
    const hashedKey = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

    await vectorStore.upsert('_reka_api_keys', [{
      id: uuidv4(),
      vector: [0],
      payload: {
        hashedKey,
        userId,
        name,
        allowedProjects,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      },
    }]);

    // Return raw key only once — user must save it
    return rawKey;
  }

  async validateApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
    // Scroll all keys (small collection, typically < 100 records)
    const result = await vectorStore.scrollCollection('_reka_api_keys', 500);
    for (const point of result.points) {
      const match = await bcrypt.compare(rawKey, point.payload.hashedKey as string);
      if (match) {
        // Update lastUsedAt
        await vectorStore.updatePayload('_reka_api_keys', point.id, {
          lastUsedAt: new Date().toISOString(),
        });
        return point.payload as unknown as ApiKeyRecord;
      }
    }
    return null;
  }
}
```

**Important:** `JWT_SECRET` must be generated during installation and stored securely. The installer should generate it:
```bash
JWT_SECRET=$(openssl rand -hex 32)
echo "JWT_SECRET=$JWT_SECRET" >> "$REKA_DIR/.env"
```

### 7.2 API Key Management

- Keys prefixed with `reka_` for easy identification in logs
- 256-bit entropy (64 hex chars after prefix)
- Stored as bcrypt hashes (never plaintext)
- Key rotation: create new key, update clients, revoke old key
- Key expiry: optional `expiresAt` field, checked during validation
- Key listing endpoint returns metadata only (name, projects, created, last used) — never the key itself
- Rate limits: each key has an optional `rateLimit` override

### 7.3 CORS Configuration

Current state: `app.use(cors())` — allows all origins. This must be restricted.

```typescript
// packages/api/src/server.ts
app.use(cors({
  origin: config.CORS_ORIGINS || ['http://localhost:3000'], // Dashboard only
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Project-Name', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400, // 24h preflight cache
}));
```

Config: `CORS_ORIGINS=http://localhost:3000,https://dashboard.reka.dev`

### 7.4 Input Validation Audit

Current state: Zod schemas in `rag-api/src/utils/validation.ts` cover most routes. Gaps to close:

- [ ] `projectPath` in indexing: validate it is an absolute path, exists, and is within allowed directories
- [ ] `collection` parameter: validate against injection (already regex-constrained: `^[a-z0-9_-]+$`)
- [ ] Request body size: already limited to 10MB (`express.json({ limit: '10mb' })`) — appropriate
- [ ] Query string params: add Zod validation for `limit`, `offset` in GET routes (some use raw `parseInt`)
- [ ] File content in `/api/index/upload`: validate MIME type, reject binary
- [ ] Memory content: add max length (current: unlimited; add `z.string().max(50000)`)
- [ ] Tags: validate array length (`z.array().max(20)`) and tag format

```typescript
// Add to validation.ts
export const projectPathSchema = z.string()
  .min(1)
  .max(500)
  .refine(p => path.isAbsolute(p), 'Must be an absolute path')
  .refine(p => !p.includes('..'), 'Path traversal not allowed');
```

### 7.5 Dependency Vulnerability Scan

Set up automated scanning:

```yaml
# .github/workflows/security.yml
name: Security Scan
on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6 AM
  push:
    branches: [main]

jobs:
  audit:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: [rag-api, mcp-server, dashboard]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd ${{ matrix.package }} && npm ci && npm audit --audit-level=high
      - run: npx snyk test --severity-threshold=high
```

### 7.6 Container Security

```yaml
# docker/docker-compose.yml changes
services:
  rag-api:
    # Run as non-root
    user: "1000:1000"
    # Read-only filesystem where possible
    read_only: true
    tmpfs:
      - /tmp
    # Drop all capabilities, add only needed
    cap_drop:
      - ALL
    # No new privileges
    security_opt:
      - no-new-privileges:true
    # Resource limits (already present)
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'
```

```dockerfile
# rag-api/Dockerfile additions
FROM node:20-slim AS runner

# Create non-root user
RUN groupadd -r reka && useradd -r -g reka -d /app -s /sbin/nologin reka

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json .

# Own the app directory
RUN chown -R reka:reka /app

USER reka

EXPOSE 3100
CMD ["node", "dist/server.js"]
```

### 7.7 Secrets Management

- Never log API keys, passwords, or JWT secrets (audit all `logger.*` calls)
- Redact `Authorization` and `X-API-Key` headers in request logs
- Environment variables for all secrets (never in config files)
- `.env` files in `.gitignore` (already true)
- Docker secrets support for production deployments

```typescript
// packages/api/src/utils/logger.ts — add redaction
const REDACT_HEADERS = ['authorization', 'x-api-key', 'cookie'];

function redactSensitive(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  const redacted = { ...obj };
  for (const key of Object.keys(redacted)) {
    if (REDACT_HEADERS.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
}
```

---

## Timeline Summary

**Phase 1 — MVP (Weeks 1-8)**
- Weeks 1-2: Auth (1a), Health Check (1i), Config Simplification (1h), Error Handling (1f)
- Weeks 3-5: CLI Tool (1b), Memory Review UI (1c)
- Weeks 5-6: File Watching (1d), Rate Limit Improvements (1j)
- Weeks 6-7: Onboarding Flow (1e), Data Export (1g)
- Week 8: Integration testing, security audit, documentation

**Phase 2 — Post-MVP (Weeks 9-16)**
- Weeks 9-10: Streaming Responses (2g), Tree-sitter (2a)
- Weeks 11-12: GitHub Webhooks (2b), Multi-Language Parsers (2h)
- Weeks 13-14: VS Code Extension (2f), Cross-Project Memory (2d)
- Weeks 15-16: PR Review Automation (2c), Scheduled Re-indexing (2i)

**Phase 3 — Scale (Weeks 17+)**
- Multi-Tenant SaaS (2e)
- Plugin System (2j)
