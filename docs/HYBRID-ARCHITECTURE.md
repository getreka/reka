Now I have everything I need. Here is the complete design document.

---

# Reka: Hybrid Deployment Architecture

## 1. Hybrid Architecture -- Reka Edge + Reka Cloud

### Architecture Diagram

```
DEVELOPER MACHINE (Reka Edge)
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌──────────────────────┐     ┌──────────────────────────────────────────┐  │
│  │  AI Assistant         │     │  Reka Edge Agent (:3100)                │  │
│  │  (Claude/Cursor/etc.) │────▶│                                        │  │
│  │                       │MCP  │  ┌─────────────┐  ┌─────────────────┐  │  │
│  └──────────────────────┘     │  │ MCP Server   │  │ Indexer Engine  │  │  │
│                                │  │ (stdio)      │  │ (fs.readFile)   │  │  │
│                                │  └──────┬──────┘  └────────┬────────┘  │  │
│                                │         │                  │           │  │
│                                │  ┌──────▼──────────────────▼────────┐  │  │
│                                │  │ Edge Router                      │  │  │
│                                │  │  - Local-only ops (index, fs)    │  │  │
│                                │  │  - Cache-first resolution        │  │  │
│                                │  │  - Cloud proxy for remote ops    │  │  │
│                                │  │  - Offline queue                 │  │  │
│                                │  └──────┬───────────────────────────┘  │  │
│                                │         │                              │  │
│                                │  ┌──────▼──────┐  ┌────────────────┐  │  │
│                                │  │ Local Cache  │  │ BGE-M3         │  │  │
│                                │  │ (SQLite)     │  │ (Profile B/C)  │  │  │
│                                │  │ - embeddings │  │ :8080          │  │  │
│                                │  │ - hot search │  │ (optional)     │  │  │
│                                │  │ - sessions   │  └────────────────┘  │  │
│                                │  └─────────────┘                       │  │
│                                └──────────────┬─────────────────────────┘  │
└───────────────────────────────────────────────┼─────────────────────────────┘
                                                │
                                    HTTPS/WSS (TLS 1.3)
                                    Authorization: Bearer <JWT>
                                    X-Edge-Id: <edge-uuid>
                                                │
════════════════════════════════════════════════╪══════════════════════════════
                                                │
REKA CLOUD (Managed Infrastructure)             │
┌───────────────────────────────────────────────┼─────────────────────────────┐
│                                               │                             │
│  ┌────────────────────────────────────────────▼──────────────────────────┐  │
│  │ API Gateway (Nginx/Envoy)                                            │  │
│  │  - TLS termination                                                   │  │
│  │  - Rate limiting (per-org, per-tier)                                 │  │
│  │  - JWT validation                                                    │  │
│  │  - Request routing (org → shard)                                     │  │
│  │  - WebSocket upgrade for streaming                                   │  │
│  └───┬──────────────┬──────────────┬────────────────┬───────────────────┘  │
│      │              │              │                │                       │
│  ┌───▼───┐   ┌──────▼──────┐  ┌───▼────────┐  ┌───▼─────────────────┐    │
│  │ Reka  │   │ Memory      │  │ LLM Router │  │ Auth & Billing      │    │
│  │ API   │   │ Governance  │  │            │  │                     │    │
│  │ (:3100│   │ Engine      │  │ - Claude   │  │ - JWT issuer        │    │
│  │ x N)  │   │             │  │ - GPT-4    │  │ - Org/User/Project  │    │
│  │       │   │ - Quarantine│  │ - Ollama   │  │ - Usage metering    │    │
│  │       │   │ - Promote   │  │ - Routing  │  │ - Stripe billing    │    │
│  │       │   │ - Decay     │  │ - Fallback │  │ - API key mgmt      │    │
│  │       │   │ - Compact   │  │ - Budget   │  │                     │    │
│  └───┬───┘   └──────┬──────┘  └───┬────────┘  └─────────────────────┘    │
│      │              │              │                                       │
│  ┌───▼──────────────▼──────────────▼────────────────────────────────────┐  │
│  │ Data Layer                                                           │  │
│  │                                                                      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │  │
│  │  │ Qdrant   │  │ Redis    │  │ Postgres │  │ Object Storage   │    │  │
│  │  │ Cluster  │  │ Cluster  │  │          │  │ (S3/R2)          │    │  │
│  │  │          │  │          │  │ - Users  │  │ - Snapshots      │    │  │
│  │  │ - code   │  │ - cache  │  │ - Orgs   │  │ - Exports        │    │  │
│  │  │ - memory │  │ - rate   │  │ - Usage  │  │ - Backups        │    │  │
│  │  │ - graph  │  │ - session│  │ - Audit  │  │                  │    │  │
│  │  │ - docs   │  │ - locks  │  │ - Billing│  │                  │    │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Dashboard (:3000) — Vue 3                                           │  │
│  │  - Memory review/promote UI                                         │  │
│  │  - Project analytics                                                │  │
│  │  - Team management                                                  │  │
│  │  - Billing/usage                                                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagrams

#### Flow 1: Code Indexing (local files to cloud vectors)

```
Developer triggers index_codebase via MCP
          │
          ▼
┌─────────────────────┐
│ Edge: Indexer Engine │
│                     │
│ 1. Walk filesystem  │     Files never leave
│ 2. Parse/chunk      │     the machine. Only
│ 3. AST extraction   │◄─── chunks + embeddings
│ 4. Symbol index     │     are sent to cloud.
│ 5. Graph edges      │
└─────────┬───────────┘
          │ chunks[]
          ▼
┌─────────────────────┐
│ Edge: Embedding     │  Profile A: POST chunks to cloud /api/embed/batch
│                     │  Profile B: Local BGE-M3 :8080/embed/batch
│ (local or remote)   │  Profile C: Local BGE-M3
└─────────┬───────────┘
          │ {chunk, vector}[]
          ▼
┌─────────────────────┐
│ Edge: Cloud Sync    │
│                     │
│ POST /api/v2/ingest │  Batched, gzipped
│ {                   │  Max 100 points/batch
│   vectors: [...],   │
│   payloads: [...],  │  Payload: metadata only
│   collection: "...",│  (file path, language,
│   org_id: "...",    │   symbols, line numbers)
│   project: "..."    │
│ }                   │  NO source code in
└─────────┬───────────┘  payload (privacy)
          │
          ▼ HTTPS
┌─────────────────────┐
│ Cloud: Reka API     │
│                     │
│ 1. Validate JWT     │
│ 2. Check quota      │
│ 3. Upsert Qdrant    │
│    collection:      │
│    {org}_{proj}_code │
│ 4. Update metrics   │
└─────────────────────┘
```

**Privacy note**: By default, source code content is NOT sent to the cloud. Only embeddings (opaque float vectors) and structural metadata (file paths, symbol names, line numbers, language) are transmitted. Users can opt in to sending code content for cloud-side `ask_codebase` / `explain_code` features. See Section 4 for privacy controls.

#### Flow 2: Search Query

```
AI Assistant calls search_codebase("auth middleware")
          │
          ▼
┌──────────────────────┐
│ Edge: MCP Server     │
│                      │
│ 1. Check local cache │──── HIT ──▶ Return cached results
│    (SQLite, 5min TTL)│
│           │          │
│          MISS        │
│           │          │
│ 2. Compute embedding │  Local (B/C) or cloud (A)
│           │          │
│ 3. Forward to cloud  │
│    POST /api/v2/search
│    {                 │
│      query: "...",   │
│      vector: [...],  │  Send pre-computed embedding
│      collection: "...",
│      limit: 10,      │
│      filters: {...}  │
│    }                 │
└──────────┬───────────┘
           │ HTTPS
           ▼
┌──────────────────────┐
│ Cloud: Reka API      │
│                      │
│ 1. Qdrant search     │
│ 2. Rerank (LLM)     │
│ 3. Enrich metadata   │
│ 4. Return results    │
│    (scores, metadata,│
│     snippets if      │
│     code-upload ON)  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Edge: Result Handler │
│                      │
│ 1. Cache results     │
│ 2. Hydrate with      │
│    local file content│  Read actual code from
│    (fs.readFile)     │  local filesystem
│ 3. Return to MCP     │
└──────────────────────┘
```

**Key insight**: Search results from the cloud contain metadata (file paths, line numbers, scores). The Edge hydrates these with actual file content from the local filesystem. This means the cloud never needs to store source code, yet the AI assistant gets full code context.

#### Flow 3: Memory Creation

```
AI calls remember("Use React Query for server state")
          │
          ▼
┌──────────────────────┐
│ Edge: MCP Server     │
│                      │
│ 1. Determine source: │
│    - manual (user)   │  ──▶ Durable (skip quarantine)
│    - auto_*          │  ──▶ Quarantine
│                      │
│ 2. Compute embedding │
│                      │
│ 3. POST /api/v2/memory
│    {                 │
│      content: "...", │
│      type: "decision",
│      source: "manual",
│      embedding: [...],
│      tags: ["react"],│
│      project: "...", │
│      org: "..."      │
│    }                 │
└──────────┬───────────┘
           │ HTTPS
           ▼
┌──────────────────────┐
│ Cloud: Memory Engine │
│                      │
│ 1. Relationship      │  Detect supersedes/
│    classification    │  contradicts/extends
│                      │
│ 2. Store in Qdrant   │
│    collection:       │
│    {org}_{proj}_memory│
│                      │
│ 3. If auto_*:        │
│    quarantine_until = │
│    now + 7 days      │
│                      │
│ 4. Trigger           │
│    consolidation     │  Async: merge, compact,
│    agent (async)     │  episodic→semantic
│                      │
│ 5. Return memory_id  │
└──────────────────────┘

           ... 7 days later (or manual review) ...

┌──────────────────────┐
│ Cloud: Dashboard     │
│                      │
│ User reviews         │
│ quarantined memories │
│ via web UI           │
│                      │
│ Actions:             │
│ - Promote (durable)  │
│ - Edit + Promote     │
│ - Reject (delete)    │
│ - Merge with another │
└──────────────────────┘
```

#### Flow 4: Session Management

```
start_session()
    │
    ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Edge: Session Store  │      │ Cloud: Session Sync   │
│                      │      │                       │
│ 1. Create local      │      │ 1. Store session meta │
│    session (SQLite)  │─────▶│    (Postgres)         │
│                      │      │                       │
│ 2. Load hot cache:   │      │ 2. Return previous    │
│    - recent memories │◀─────│    session context     │
│    - project profile │      │    (cross-device       │
│    - active ADRs     │      │     continuity)        │
│                      │      │                       │
│ 3. Predictive load   │      │                       │
│    (pre-fetch likely │      │                       │
│     needed data)     │      │                       │
└──────────────────────┘      └───────────────────────┘

    ... during session: all ops cached locally ...

end_session()
    │
    ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Edge: Session Close  │      │ Cloud: Persist        │
│                      │      │                       │
│ 1. Extract learnings │─────▶│ 1. Store session log  │
│ 2. Auto-remember     │      │ 2. Process learnings  │
│ 3. Flush cache stats │      │ 3. Update analytics   │
│ 4. Sync pending ops  │      │ 4. Trigger cleanup    │
└──────────────────────┘      └───────────────────────┘
```

---

## 2. Deployment Profiles

### Profile A: "Cloud-First" (Easiest Onboarding)

**What runs locally**: Indexer + MCP server + SQLite cache (approximately 50MB RAM)
**What runs in cloud**: Qdrant, LLM, embeddings, API, dashboard, memory governance

```yaml
# docker-compose.edge-cloud.yml
# Profile A: Cloud-First — minimal local footprint
version: '3.8'

services:
  reka-edge:
    image: ghcr.io/reka-ai/reka-edge:latest
    container_name: reka-edge
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      # Mount project directories for indexing (read-only)
      - ${HOME}/projects:/projects:ro
      # Local cache persisted across restarts
      - reka_edge_cache:/data/cache
      # Config file
      - ./reka.config.yaml:/etc/reka/config.yaml:ro
    environment:
      - REKA_CLOUD_URL=https://api.reka.dev
      - REKA_API_KEY=${REKA_API_KEY}
      - REKA_ORG_ID=${REKA_ORG_ID}
      - REKA_PROFILE=cloud-first
      - REKA_CACHE_DIR=/data/cache
    deploy:
      resources:
        limits:
          memory: 256M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  reka_edge_cache:
    name: reka_edge_cache
```

**User setup** (5 env vars):
```bash
export REKA_API_KEY=rk_live_abc123...
export REKA_ORG_ID=org_mycompany
docker compose -f docker-compose.edge-cloud.yml up -d
```

**MCP configuration** (in consumer project `.mcp.json`):
```json
{
  "mcpServers": {
    "reka": {
      "command": "docker",
      "args": ["exec", "-i", "reka-edge", "node", "/app/mcp-server/dist/index.js"],
      "env": {
        "PROJECT_NAME": "myproject",
        "PROJECT_PATH": "/projects/myproject",
        "RAG_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

### Profile B: "Hybrid" (Balanced)

**What runs locally**: Indexer + MCP server + BGE-M3 embeddings + SQLite cache (approximately 5GB RAM)
**What runs in cloud**: Qdrant, LLM routing, memory governance, dashboard

```yaml
# docker-compose.edge-hybrid.yml
# Profile B: Hybrid — embeddings local, storage + LLM in cloud
version: '3.8'

services:
  reka-edge:
    image: ghcr.io/reka-ai/reka-edge:latest
    container_name: reka-edge
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ${HOME}/projects:/projects:ro
      - reka_edge_cache:/data/cache
      - ./reka.config.yaml:/etc/reka/config.yaml:ro
    environment:
      - REKA_CLOUD_URL=https://api.reka.dev
      - REKA_API_KEY=${REKA_API_KEY}
      - REKA_ORG_ID=${REKA_ORG_ID}
      - REKA_PROFILE=hybrid
      - REKA_CACHE_DIR=/data/cache
      - EMBEDDING_PROVIDER=bge-m3-server
      - BGE_M3_URL=http://bge-m3:8080
    depends_on:
      bge-m3:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  # Local embedding model — embeddings never leave the machine
  bge-m3:
    build:
      context: ./bge-m3
      dockerfile: Dockerfile
    image: ghcr.io/reka-ai/bge-m3:latest
    container_name: reka-bge-m3
    environment:
      - MODEL_NAME=BAAI/bge-m3
      - MAX_LENGTH=8192
      - USE_GPU=false
    volumes:
      - bge_m3_cache:/root/.cache
    deploy:
      resources:
        limits:
          memory: 4G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

volumes:
  reka_edge_cache:
    name: reka_edge_cache
  bge_m3_cache:
    name: reka_bge_m3_cache

networks:
  default:
    name: reka-edge-network
```

### Profile C: "Self-Hosted" (Full Control)

**What runs locally**: Everything. Zero cloud dependency.

```yaml
# docker-compose.self-hosted.yml
# Profile C: Self-Hosted — complete local deployment, community edition
version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:v1.12.6
    container_name: reka-qdrant
    ports:
      - "127.0.0.1:6333:6333"
      - "127.0.0.1:6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    deploy:
      resources:
        limits:
          memory: 4G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    container_name: reka-ollama
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    environment:
      - OLLAMA_NUM_PARALLEL=2
    deploy:
      resources:
        limits:
          memory: 24G
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  bge-m3:
    build:
      context: ./bge-m3
      dockerfile: Dockerfile
    image: ghcr.io/reka-ai/bge-m3:latest
    container_name: reka-bge-m3
    environment:
      - MODEL_NAME=BAAI/bge-m3
      - MAX_LENGTH=8192
      - USE_GPU=false
    volumes:
      - bge_m3_cache:/root/.cache
    deploy:
      resources:
        limits:
          memory: 4G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: reka-redis
    ports:
      - "127.0.0.1:6380:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    deploy:
      resources:
        limits:
          memory: 512M
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  reka-api:
    image: ghcr.io/reka-ai/reka-api:latest
    container_name: reka-api
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ${HOME}/projects:/projects:ro
      - ./reka.config.yaml:/etc/reka/config.yaml:ro
    environment:
      - QDRANT_URL=http://qdrant:6333
      - OLLAMA_URL=http://ollama:11434
      - BGE_M3_URL=http://bge-m3:8080
      - REDIS_URL=redis://redis:6379
      - API_PORT=3100
      - API_HOST=0.0.0.0
      - REKA_PROFILE=self-hosted
      - CONSOLIDATION_ENABLED=true
      - RECONSOLIDATION_ENABLED=true
      - GRAPH_RECALL_ENABLED=true
    depends_on:
      qdrant:
        condition: service_healthy
      ollama:
        condition: service_healthy
      bge-m3:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 2G
    restart: unless-stopped

  dashboard:
    image: ghcr.io/reka-ai/reka-dashboard:latest
    container_name: reka-dashboard
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      - reka-api
    deploy:
      resources:
        limits:
          memory: 256M
    restart: unless-stopped

volumes:
  qdrant_data:
    name: reka_qdrant_data
  ollama_data:
    name: reka_ollama_data
  bge_m3_cache:
    name: reka_bge_m3_cache
  redis_data:
    name: reka_redis_data

networks:
  default:
    name: reka-network
```

---

## 3. Model Configuration System

### a) Configuration File Format: `reka.config.yaml`

#### Cloud-First Config

```yaml
# reka.config.yaml — Profile A: Cloud-First
version: "1"
profile: cloud-first

edge:
  cache:
    backend: sqlite            # sqlite | redis
    path: /data/cache/reka.db
    embedding_ttl: 86400       # 24 hours
    search_ttl: 300            # 5 minutes
    max_size_mb: 500

cloud:
  url: https://api.reka.dev
  org_id: ${REKA_ORG_ID}
  api_key: ${REKA_API_KEY}
  region: auto                 # auto | us-east-1 | eu-west-1 | ap-southeast-1

embedding:
  provider: reka-cloud         # reka-cloud | bge-m3-server | openai | custom
  # No further config needed — cloud handles it
  vector_size: 1024

llm:
  provider: reka-cloud         # reka-cloud | ollama | openai | anthropic | custom
  # No further config needed — cloud handles routing

projects:
  - name: myproject
    path: /projects/myproject
    collections:
      - codebase
      - memory
      - docs

privacy:
  send_code_content: false     # Only embeddings + metadata
  send_file_paths: true        # Relative paths (stripped of home dir)
  send_symbol_names: true
  telemetry: true              # Anonymous usage analytics
```

#### Hybrid Config

```yaml
# reka.config.yaml — Profile B: Hybrid
version: "1"
profile: hybrid

edge:
  cache:
    backend: sqlite
    path: /data/cache/reka.db
    embedding_ttl: 604800      # 7 days (local embeddings are stable)
    search_ttl: 300
    max_size_mb: 2000

cloud:
  url: https://api.reka.dev
  org_id: ${REKA_ORG_ID}
  api_key: ${REKA_API_KEY}
  region: eu-west-1

embedding:
  provider: bge-m3-server      # Local BGE-M3
  url: http://bge-m3:8080
  vector_size: 1024
  batch_size: 50
  max_length: 8192

llm:
  provider: reka-cloud
  routing:                     # Override default routing
    utility: ollama            # Use local Ollama for cheap tasks if available
    standard: reka-cloud
    complex: reka-cloud

  ollama:                      # Local Ollama config (for utility tasks)
    url: http://localhost:11434
    model: qwen2.5:7b          # Small model for utility only
    timeout: 30000

projects:
  - name: myproject
    path: /projects/myproject
  - name: otherproject
    path: /projects/otherproject

privacy:
  send_code_content: false
  send_file_paths: true
  send_symbol_names: true
  telemetry: true
```

#### Self-Hosted Config

```yaml
# reka.config.yaml — Profile C: Self-Hosted
version: "1"
profile: self-hosted

edge:
  cache:
    backend: redis
    url: redis://redis:6379
    embedding_ttl: 604800
    search_ttl: 600
    max_size_mb: 4000

# No cloud section — fully local

embedding:
  provider: bge-m3-server
  url: http://bge-m3:8080
  vector_size: 1024
  batch_size: 50
  max_length: 8192

llm:
  provider: ollama
  ollama:
    url: http://ollama:11434
    model: qwen3.5:35b
    timeout: 180000
    think: true
    think_budget: 8192

  routing:
    utility: ollama
    standard: ollama
    complex: ollama            # Or anthropic if API key provided

  # Optional: bring your own API keys for complex tasks
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}  # Optional
    model: claude-sonnet-4-6
    think: true
    effort: high

  openai:
    api_key: ${OPENAI_API_KEY}     # Optional
    model: gpt-4-turbo-preview

vector:
  provider: qdrant
  url: http://qdrant:6333
  # api_key: (none needed for local)

memory:
  governance:
    quarantine_ttl_days: 7
    decay_rate: 0.10
    compaction_threshold: 0.85
    consolidation_enabled: true
    reconsolidation_enabled: true
    graph_recall_enabled: true

projects:
  - name: myproject
    path: /projects/myproject
  - name: secondproject
    path: /projects/secondproject

privacy:
  send_code_content: n/a       # Everything is local
  telemetry: false
```

### b) Model Routing Rules

The `llm.routing` configuration maps task complexity levels to providers. Here is the complete routing matrix:

```yaml
# Model routing — which tasks go to which provider
routing:
  # Task complexity → provider mapping
  utility: ollama              # query rewriting, reranking, memory merge,
                               # relationship classification, tag extraction
                               # Target: <2s, <$0.001/call

  standard: reka-cloud         # search augmentation, session summaries,
                               # pattern detection, consolidation
                               # Target: <10s, <$0.01/call

  complex: reka-cloud          # code review, explain_code, agent runtime,
                               # architectural analysis, tribunal
                               # Target: <60s, <$0.10/call

# Fallback chains (tried in order if primary fails)
fallback:
  ollama: [ollama, reka-cloud]
  reka-cloud: [reka-cloud, anthropic, openai]
  anthropic: [anthropic, reka-cloud, ollama]
  openai: [openai, reka-cloud, ollama]

# Token budgets per task type (max output tokens)
budgets:
  query_rewrite: 200
  rerank: 500
  memory_merge: 1000
  session_summary: 2000
  code_review: 4000
  explain_code: 4000
  agent_step: 2000
  tribunal_round: 3000
  consolidation: 1500

# Cost caps (monthly, per-org)
cost_caps:
  tier_free: 0                 # Self-hosted only
  tier_starter: 20.00          # $20/month
  tier_pro: 100.00             # $100/month
  tier_team: 500.00            # $500/month
```

**Implementation**: The Edge Router resolves the routing at call time:

```typescript
// Pseudocode for Edge Router provider resolution
function resolveProvider(task: string, config: RekaConfig): ProviderConfig {
  const complexity = TASK_COMPLEXITY_MAP[task]; // e.g. 'utility'
  const providerName = config.llm.routing[complexity]; // e.g. 'ollama'

  if (providerName === 'reka-cloud') {
    return { type: 'remote', url: config.cloud.url };
  }

  const providerConfig = config.llm[providerName];
  if (!providerConfig) {
    // Fallback chain
    for (const fallback of config.llm.fallback[providerName]) {
      if (isAvailable(fallback, config)) return resolveProvider(fallback, config);
    }
  }

  return { type: 'local', ...providerConfig };
}
```

The task-to-complexity mapping:

| Task | Complexity | Typical Provider |
|------|-----------|-----------------|
| `query_rewrite` | utility | Ollama |
| `rerank_results` | utility | Ollama |
| `memory_merge` | utility | Ollama |
| `relationship_classify` | utility | Ollama |
| `tag_extract` | utility | Ollama |
| `session_summary` | standard | Reka Cloud |
| `pattern_detect` | standard | Reka Cloud |
| `consolidation` | standard | Reka Cloud |
| `search_augment` | standard | Reka Cloud |
| `code_review` | complex | Reka Cloud (Claude) |
| `explain_code` | complex | Reka Cloud (Claude) |
| `agent_runtime` | complex | Reka Cloud (Claude) |
| `tribunal_judge` | complex | Reka Cloud (Claude) |
| `architectural_analysis` | complex | Reka Cloud (Claude) |

---

## 4. Edge-to-Cloud Communication Protocol

### Authentication

```
┌─────────────────────────────────────────────────────────────────┐
│ Initial Authentication (on first connect / token expiry)        │
│                                                                 │
│ Edge                              Cloud                         │
│   │                                │                            │
│   │  POST /auth/token              │                            │
│   │  {                             │                            │
│   │    api_key: "rk_live_...",     │                            │
│   │    edge_id: "edge_abc123",     │  (derived from machine    │
│   │    org_id: "org_mycompany",    │   fingerprint on first    │
│   │    edge_version: "1.2.0"      │   run, stored in cache)   │
│   │  }                            │                            │
│   │──────────────────────────────▶│                            │
│   │                                │  Validate API key          │
│   │                                │  Check org membership      │
│   │                                │  Issue JWT                 │
│   │  {                             │                            │
│   │    access_token: "eyJ...",     │  (15 min expiry)          │
│   │    refresh_token: "rk_ref_.",  │  (30 day expiry)          │
│   │    expires_at: 1711234567,     │                            │
│   │    edge_id: "edge_abc123",     │                            │
│   │    permissions: [              │                            │
│   │      "vectors:write",         │                            │
│   │      "memory:write",          │                            │
│   │      "search:read",           │                            │
│   │      "llm:invoke"             │                            │
│   │    ]                          │                            │
│   │  }                            │                            │
│   │◀──────────────────────────────│                            │
└─────────────────────────────────────────────────────────────────┘
```

**JWT claims**:
```json
{
  "sub": "user_alice",
  "org": "org_mycompany",
  "edge": "edge_abc123",
  "tier": "pro",
  "permissions": ["vectors:write", "memory:write", "search:read", "llm:invoke"],
  "iat": 1711234567,
  "exp": 1711235467,
  "iss": "reka.dev"
}
```

**All subsequent requests** include:
```
Authorization: Bearer eyJ...
X-Edge-Id: edge_abc123
X-Reka-Org: org_mycompany
X-Reka-Project: myproject
Content-Encoding: gzip          (for large payloads)
```

**Token refresh**: The Edge agent automatically refreshes the access token using the refresh token 60 seconds before expiry. If the refresh fails (e.g., API key revoked), all cloud operations fail gracefully and the edge enters offline mode.

### Data Encryption

- **In transit**: TLS 1.3 mandatory. The Edge verifies the cloud certificate against a pinned CA bundle shipped with the Edge image. Certificate pinning prevents MITM even on corporate networks with SSL inspection.
- **At rest**: Qdrant cloud uses AES-256 encryption for stored vectors. Postgres uses TDE (Transparent Data Encryption). S3/R2 uses server-side encryption.
- **Local cache**: SQLite uses SQLCipher with a key derived from the machine's hardware ID + user-provided passphrase (optional).

### What Data Leaves the Machine

| Data Type | Sent to Cloud? | Controlled By | Default |
|-----------|---------------|---------------|---------|
| Embedding vectors (float[1024]) | Yes (Profile A), No (B/C) | `embedding.provider` | Profile-dependent |
| File metadata (path, language, size) | Yes | `privacy.send_file_paths` | `true` (relative paths) |
| Symbol names (function, class, type) | Yes | `privacy.send_symbol_names` | `true` |
| Source code content | No | `privacy.send_code_content` | `false` |
| Memory text (decisions, insights) | Yes | Always (core feature) | Required |
| Search queries | Yes | Always (core feature) | Required |
| Session metadata | Yes | `privacy.telemetry` | `true` |
| Line numbers, chunk boundaries | Yes | Follows `send_file_paths` | `true` |
| Git commit hashes | Yes | `privacy.send_file_paths` | `true` |
| File content for `ask_codebase` | Opt-in only | `privacy.send_code_content` | `false` |

**Privacy mode** (`privacy.send_code_content: false`):
When code content is not sent, certain features degrade gracefully:
- `search_codebase`: Returns metadata + scores; Edge hydrates with local file content.
- `ask_codebase`: Cannot work cloud-side. Edge runs a local LLM pipeline instead (requires Profile B/C with Ollama) or returns an error on Profile A.
- `explain_code`: Same as `ask_codebase`.
- `code_review`: Requires code content. Either send content or use local LLM.

### Offline Mode

When the cloud is unreachable (network down, credentials expired, cloud outage):

```
┌─────────────────────────────────────────────────────────────┐
│ Offline Capability Matrix                                   │
│                                                             │
│ Feature              │ Profile A │ Profile B │ Profile C   │
│──────────────────────┼───────────┼───────────┼─────────────│
│ index_codebase       │ Partial*  │ Full      │ Full        │
│ search_codebase      │ Cache only│ Cache only│ Full        │
│ ask_codebase         │ No        │ Local LLM │ Full        │
│ remember             │ Queue**   │ Queue**   │ Full        │
│ recall               │ Cache only│ Cache only│ Full        │
│ start/end_session    │ Local only│ Local only│ Full        │
│ dashboard            │ No        │ No        │ Full        │
│                                                             │
│ * Partial: can read/chunk files, but cannot embed (no      │
│   local model) or store vectors. Chunks queued for sync.    │
│ ** Queue: stored locally in SQLite, synced when online.     │
└─────────────────────────────────────────────────────────────┘
```

### Sync Protocol (After Offline Period)

When connectivity is restored:

```
Edge                                Cloud
  │                                   │
  │  POST /api/v2/sync/status         │
  │  { edge_id, last_sync_at }        │
  │──────────────────────────────────▶│
  │                                   │
  │  { cloud_version: 47,             │
  │    edge_version: 42,              │  Cloud knows last
  │    delta_count: 12 }              │  confirmed sync point
  │◀──────────────────────────────────│
  │                                   │
  │  POST /api/v2/sync/push           │  Edge pushes pending ops
  │  {                                │  in causal order
  │    ops: [                         │
  │      { seq: 43, op: "upsert",     │
  │        collection: "...",         │
  │        points: [...] },           │
  │      { seq: 44, op: "memory",     │
  │        action: "create",          │
  │        payload: {...} },          │
  │      ...                          │
  │    ],                             │
  │    edge_id: "...",                │
  │    checksum: "sha256:..."         │  Integrity check
  │  }                                │
  │──────────────────────────────────▶│
  │                                   │  Apply ops idempotently
  │  { applied: 5,                    │  (dedup by op_id)
  │    conflicts: [                   │
  │      { seq: 45, reason: "...",    │  Conflicts returned
  │        resolution: "cloud_wins" } │  for edge to handle
  │    ],                             │
  │    cloud_version: 52 }            │
  │◀──────────────────────────────────│
  │                                   │
  │  POST /api/v2/sync/pull           │  Edge pulls changes
  │  { since_version: 42 }            │  made on other edges
  │──────────────────────────────────▶│  or via dashboard
  │                                   │
  │  { ops: [...],                    │
  │    version: 52 }                  │
  │◀──────────────────────────────────│
  │                                   │
  │  (Apply remote ops locally)       │
  │  (Update local sync cursor)       │
```

**Conflict resolution**: Last-write-wins for memories and metadata. For vector upserts, cloud always wins (vectors are deterministic from content). For memory edits made via dashboard while edge was offline, cloud version takes precedence and edge is notified.

---

## 5. Multi-Tenancy Architecture

### Tenant Hierarchy

```
Organization (org_mycompany)
├── Users
│   ├── user_alice (role: admin)
│   ├── user_bob (role: member)
│   └── user_carol (role: viewer)
├── Teams
│   ├── team_backend
│   │   ├── user_alice
│   │   └── user_bob
│   └── team_frontend
│       └── user_carol
├── Projects
│   ├── proj_api (team: backend)
│   │   ├── Collections: org_mycompany__proj_api__codebase
│   │   │                org_mycompany__proj_api__memory
│   │   │                org_mycompany__proj_api__docs
│   │   │                org_mycompany__proj_api__graph
│   │   │                org_mycompany__proj_api__symbols
│   │   └── Edge Instances: [edge_abc123, edge_def456]
│   └── proj_frontend (team: frontend)
│       ├── Collections: org_mycompany__proj_frontend__codebase
│       │                org_mycompany__proj_frontend__memory
│       └── Edge Instances: [edge_ghi789]
├── API Keys
│   ├── rk_live_abc... (scope: full, created_by: alice)
│   └── rk_live_def... (scope: read-only, created_by: bob)
└── Subscription
    ├── tier: pro
    ├── vector_quota: 5_000_000 points
    ├── llm_budget: $100/month
    └── members_limit: 25
```

### Qdrant Collection Isolation

Collections are namespaced as `{org_id}__{project_name}__{collection_type}`:

```
org_mycompany__proj_api__codebase       # Code vectors
org_mycompany__proj_api__memory         # Memory vectors
org_mycompany__proj_api__docs           # Documentation vectors
org_mycompany__proj_api__graph          # Dependency graph edges
org_mycompany__proj_api__symbols        # Symbol index
org_mycompany__proj_api__confluence     # Confluence pages
```

**Why double underscore**: Single underscore is used within project names (e.g., `my_project`). Double underscore is a reserved delimiter that cannot appear in org or project names (enforced at registration).

**Access control**: The API gateway injects the org_id from the JWT into every Qdrant query. The Reka API layer enforces that `collection.startsWith(jwt.org + '__')`. No cross-org access is possible at the application layer.

**Qdrant cluster topology** (for large deployments):
- Small orgs: shared Qdrant cluster with collection-level isolation
- Enterprise orgs: dedicated Qdrant shard group (`placement` strategy) for performance isolation
- Data residency: region-specific Qdrant clusters (EU cluster, US cluster)

### Postgres Schema (Cloud)

```sql
-- Organizations
CREATE TABLE organizations (
    id          TEXT PRIMARY KEY,           -- org_mycompany
    name        TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free', -- free, starter, pro, team, enterprise
    region      TEXT NOT NULL DEFAULT 'us-east-1',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settings    JSONB DEFAULT '{}'
);

-- Users
CREATE TABLE users (
    id          TEXT PRIMARY KEY,           -- user_alice
    email       TEXT UNIQUE NOT NULL,
    org_id      TEXT NOT NULL REFERENCES organizations(id),
    role        TEXT NOT NULL DEFAULT 'member', -- admin, member, viewer
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Projects
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,           -- proj_api
    org_id      TEXT NOT NULL REFERENCES organizations(id),
    name        TEXT NOT NULL,
    team_id     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settings    JSONB DEFAULT '{}',
    UNIQUE (org_id, name)
);

-- Edge Instances
CREATE TABLE edges (
    id              TEXT PRIMARY KEY,       -- edge_abc123
    org_id          TEXT NOT NULL REFERENCES organizations(id),
    user_id         TEXT NOT NULL REFERENCES users(id),
    machine_hash    TEXT NOT NULL,          -- SHA256 of machine fingerprint
    last_seen_at    TIMESTAMPTZ,
    last_sync_at    TIMESTAMPTZ,
    sync_version    BIGINT DEFAULT 0,
    edge_version    TEXT,                   -- Software version
    status          TEXT DEFAULT 'active',  -- active, revoked
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys
CREATE TABLE api_keys (
    id          TEXT PRIMARY KEY,           -- rk_live_abc...
    org_id      TEXT NOT NULL REFERENCES organizations(id),
    created_by  TEXT NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL,              -- bcrypt hash, never store plaintext
    scope       TEXT NOT NULL DEFAULT 'full', -- full, read-only, index-only
    last_used   TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usage Metering
CREATE TABLE usage_events (
    id          BIGSERIAL PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id),
    project_id  TEXT REFERENCES projects(id),
    edge_id     TEXT REFERENCES edges(id),
    event_type  TEXT NOT NULL,             -- search, index, llm_call, memory_write
    tokens_in   INT DEFAULT 0,
    tokens_out  INT DEFAULT 0,
    cost_usd    NUMERIC(10,6) DEFAULT 0,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partitioned by month for efficient queries
CREATE INDEX idx_usage_org_month ON usage_events (org_id, created_at);

-- Sessions (cross-device continuity)
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id),
    project_id  TEXT NOT NULL REFERENCES projects(id),
    edge_id     TEXT REFERENCES edges(id),
    user_id     TEXT REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'active',
    context     JSONB DEFAULT '{}',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    summary     TEXT
);
```

### Resource Limits per Tier

| Resource | Free | Starter ($20/mo) | Pro ($100/mo) | Team ($500/mo) | Enterprise |
|----------|------|------------------|---------------|----------------|------------|
| Vector points | 100K | 1M | 5M | 25M | Custom |
| Projects | 2 | 5 | 20 | Unlimited | Unlimited |
| Members | 1 | 3 | 10 | 50 | Custom |
| Edge instances | 1 | 3 | 10 | 50 | Custom |
| LLM calls/month | 0 | 5K | 25K | 100K | Custom |
| LLM budget/month | $0 | $20 | $100 | $500 | Custom |
| Memory entries | 1K | 10K | 50K | 250K | Custom |
| Indexing rate | 10 files/min | 50/min | 200/min | 1000/min | Custom |
| Search rate | 10/min | 60/min | 300/min | 1000/min | Custom |
| Data retention | 30 days | 1 year | Unlimited | Unlimited | Custom |
| Support | Community | Email | Priority | Dedicated | Custom |
| Data residency | US only | US/EU | US/EU/APAC | Any | Custom |

### Data Residency

Each organization selects a region at creation time. The region determines:
- Which Qdrant cluster stores their vectors
- Which Postgres replica handles their metadata
- Which S3 bucket stores their backups
- Which API gateway endpoint they connect to

```yaml
# Region-to-endpoint mapping
regions:
  us-east-1:
    api: https://us.api.reka.dev
    qdrant: qdrant-us.reka.dev:6334
  eu-west-1:
    api: https://eu.api.reka.dev
    qdrant: qdrant-eu.reka.dev:6334
  ap-southeast-1:
    api: https://ap.api.reka.dev
    qdrant: qdrant-ap.reka.dev:6334
```

The Edge agent discovers its region endpoint during initial authentication and caches it.

---

## 6. Migration Path

### Migration A: Current Self-Hosted to New Hybrid

This migrates the existing `shared-ai-infra` deployment to Reka Hybrid.

**Step 1: Export existing data**

```bash
# Export script: reka-migrate export
# Reads from local Qdrant, writes to portable format

reka-cli migrate export \
  --qdrant-url http://localhost:6333 \
  --output /tmp/reka-export \
  --projects myproject,otherproject

# Creates:
# /tmp/reka-export/
#   manifest.json                       # Export metadata
#   myproject/
#     codebase.vectors.jsonl            # Points with payloads
#     memory.vectors.jsonl
#     docs.vectors.jsonl
#     graph.vectors.jsonl
#     symbols.vectors.jsonl
#   otherproject/
#     ...
```

`manifest.json`:
```json
{
  "version": "1",
  "exported_at": "2026-03-26T10:00:00Z",
  "source": "self-hosted",
  "vector_size": 1024,
  "embedding_provider": "bge-m3-server",
  "projects": [
    {
      "name": "myproject",
      "collections": {
        "codebase": { "points": 45230, "size_mb": 180 },
        "memory": { "points": 342, "size_mb": 2 },
        "docs": { "points": 1200, "size_mb": 5 },
        "graph": { "points": 8900, "size_mb": 12 },
        "symbols": { "points": 15600, "size_mb": 20 }
      }
    }
  ],
  "total_points": 71272,
  "total_size_mb": 219,
  "checksum": "sha256:abc123..."
}
```

**Step 2: Create Reka Cloud account and import**

```bash
# Sign up at https://reka.dev, get API key
export REKA_API_KEY=rk_live_...
export REKA_ORG_ID=org_mycompany

reka-cli migrate import \
  --input /tmp/reka-export \
  --cloud-url https://api.reka.dev \
  --api-key $REKA_API_KEY \
  --org-id $REKA_ORG_ID \
  --batch-size 100 \
  --parallel 4

# Progress:
# Importing myproject/codebase... 45230/45230 points [====] 100%
# Importing myproject/memory... 342/342 points [====] 100%
# ...
# Import complete. 71272 points in 4m32s.
```

**Step 3: Switch to hybrid docker-compose**

```bash
# Stop old infrastructure
cd docker && docker-compose down

# Start new hybrid edge
cp reka.config.yaml.hybrid reka.config.yaml
docker compose -f docker-compose.edge-hybrid.yml up -d

# Verify
curl http://localhost:3100/health
# { "status": "ok", "profile": "hybrid", "cloud": "connected" }
```

**Step 4: Update MCP configs** in consumer projects:

```json
{
  "mcpServers": {
    "reka": {
      "command": "docker",
      "args": ["exec", "-i", "reka-edge", "node", "/app/mcp-server/dist/index.js"],
      "env": {
        "PROJECT_NAME": "myproject",
        "PROJECT_PATH": "/projects/myproject",
        "RAG_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

The MCP server configuration does not change since the Edge agent exposes the same API surface as the current Reka API on `:3100`. Only the backend routing changes (local vs. cloud).

### Migration B: Cloud-First to Self-Hosted (Data Export)

For users who want to leave the cloud and take their data with them.

```bash
# Step 1: Export from cloud
reka-cli migrate export \
  --cloud-url https://api.reka.dev \
  --api-key $REKA_API_KEY \
  --org-id $REKA_ORG_ID \
  --output /tmp/reka-export \
  --include-all                      # All projects, all collections

# Step 2: Set up self-hosted infrastructure
git clone https://github.com/reka-ai/reka.git
cd reka
cp reka.config.yaml.self-hosted reka.config.yaml
docker compose -f docker-compose.self-hosted.yml up -d

# Wait for services to be healthy
docker compose -f docker-compose.self-hosted.yml ps
# All services should show "healthy"

# Step 3: Import into local Qdrant
reka-cli migrate import \
  --input /tmp/reka-export \
  --qdrant-url http://localhost:6333 \
  --batch-size 100

# Step 4: Re-index if embedding provider changed
# (Only needed if switching from cloud embeddings to local BGE-M3
#  and the vector sizes differ. If both use BGE-M3 1024d, skip this.)
reka-cli reindex \
  --projects myproject \
  --reason "embedding-provider-change"

# Step 5: Verify
curl http://localhost:3100/api/stats?project=myproject
# { "codebase": 45230, "memory": 342, ... }
```

**Data portability guarantee**: The export format is a documented JSONL schema. Each line contains a point with its vector and full payload. No vendor lock-in on the data format.

### Migration C: Self-Hosted to Cloud-First (Data Import)

For users who want to move from fully local to cloud-managed.

```bash
# Step 1: Export from local (same as Migration A, Step 1)
reka-cli migrate export \
  --qdrant-url http://localhost:6333 \
  --output /tmp/reka-export \
  --projects myproject

# Step 2: Import to cloud (same as Migration A, Step 2)
reka-cli migrate import \
  --input /tmp/reka-export \
  --cloud-url https://api.reka.dev \
  --api-key $REKA_API_KEY \
  --org-id $REKA_ORG_ID

# Step 3: Switch to cloud-first compose
docker compose -f docker-compose.self-hosted.yml down
docker compose -f docker-compose.edge-cloud.yml up -d

# Step 4: Optional - keep local Qdrant data as backup
# The old volumes are preserved until you explicitly remove them:
# docker volume rm reka_qdrant_data  (only when confident)
```

### Migration CLI: `reka-cli migrate`

```
reka-cli migrate export    Export data from local or cloud
  --qdrant-url <url>       Source Qdrant (for local export)
  --cloud-url <url>        Source cloud (for cloud export)
  --api-key <key>          Cloud API key (for cloud export)
  --org-id <org>           Cloud org (for cloud export)
  --output <dir>           Output directory
  --projects <list>        Comma-separated project names (default: all)
  --collections <list>     Collection types (default: all)
  --since <date>           Only export points created/updated after date
  --format jsonl|parquet   Output format (default: jsonl)

reka-cli migrate import    Import data to local or cloud
  --input <dir>            Input directory (from export)
  --qdrant-url <url>       Target Qdrant (for local import)
  --cloud-url <url>        Target cloud (for cloud import)
  --api-key <key>          Cloud API key
  --org-id <org>           Cloud org
  --batch-size <n>         Points per batch (default: 100)
  --parallel <n>           Parallel upload streams (default: 4)
  --dry-run                Show what would be imported without doing it
  --skip-existing          Skip points that already exist (by ID)

reka-cli migrate verify    Verify migration integrity
  --source <url>           Source (local or cloud)
  --target <url>           Target (local or cloud)
  --projects <list>        Projects to verify
  --sample-rate <float>    Fraction of points to spot-check (default: 0.01)
```

---

## Summary of Key Design Decisions

1. **Edge is a thin proxy, not a fork**: The Edge agent runs the same Express server codebase as the current `rag-api`, but configured in "edge mode" via `REKA_PROFILE`. Routes that need filesystem access (indexing) execute locally. Routes that need vector storage or LLM calls proxy to the cloud. This avoids maintaining two separate codebases.

2. **SQLite replaces Redis on the Edge**: For Profiles A and B, running a Redis container locally is overkill. SQLite (via `better-sqlite3`) provides the same caching semantics with zero operational overhead. Profile C retains Redis for compatibility with the existing architecture.

3. **Collection namespacing uses double underscore**: `{org}__{project}__{type}` prevents ambiguity with project names that contain underscores. The current single-underscore scheme (`{project}_{type}`) is preserved for self-hosted/community deployments via a config flag.

4. **Embeddings are the privacy boundary**: The critical architectural insight is that embeddings are one-way transformations. Sending `float[1024]` to the cloud exposes no recoverable source code. This makes Profile B (local embeddings, cloud storage) the sweet spot for privacy-conscious teams.

5. **Offline-first sync uses operation log**: Rather than full state sync, the Edge maintains a monotonically increasing sequence number for each operation. Sync pushes operations by sequence, the cloud applies them idempotently (dedup by operation ID). This handles intermittent connectivity gracefully.

6. **No breaking changes to MCP interface**: All three profiles expose the same MCP tools on `localhost:3100`. Consumer projects only need to set `PROJECT_NAME` and `PROJECT_PATH`. The Edge/Cloud split is invisible to the AI assistant.
