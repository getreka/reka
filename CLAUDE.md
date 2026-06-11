# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Standing repo policy

- **Subtraction rule:** capabilities are deleted, never hidden. No hidden tool tiers, no dead code kept "just in case". Every deletion lands with ALL of its sweeps (registrations, annotations, timeouts, skip-lists, tests, doc rows) in the same PR, and the deletion diff is net-negative. Before any release, grep the repo (and the reka-plugin tree) for every removed tool name — zero live references.
- **Proof rule:** no public surface (README, landing page, docs, plugin copy, dashboard) may claim a capability or count that has not been verified live. Tool counts state what is actually registered today; feature claims require a working, observed code path.

## Build and Run Commands

### RAG API (main backend service)

```bash
cd rag-api
npm install
npm run build        # Compile TypeScript
npm run dev          # Development with ts-node
npm start            # Production (requires build)
```

### MCP Server

```bash
cd mcp-server
npm install
npm run build        # Compile TypeScript
npm start            # Run server
```

### Infrastructure (Docker)

```bash
cd docker
docker-compose up -d              # Start all services
docker-compose down               # Stop services
docker-compose logs -f rag-api    # View logs
```

## Architecture Overview

This is a **shared RAG (Retrieval-Augmented Generation) infrastructure** that can serve multiple projects without context conflicts.

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Server (per project instance)                          │
│  - Wraps RAG API as MCP tools                              │
│  - Configured via env: PROJECT_NAME, PROJECT_PATH          │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (X-Project-Name header)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  RAG API (:3100)                                            │
│  - Express server                                           │
│  - Routes: /api/search, /api/ask, /api/index, /api/memory  │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐      ┌──────────────┐    ┌─────────┐
   │ Qdrant  │      │    Ollama    │    │  Redis  │
   │ :6333   │      │    :11434    │    │  :6380  │
   │ vectors │      │ LLM + embeds │    │  cache  │
   └─────────┘      └──────────────┘    └─────────┘
```

Embeddings come from Ollama (`qwen3-embedding:4b`). BGE-M3 (:8080) is **optional** — it is only used as a reranker (`RERANKER_ENABLED=true` plus a running `bge-m3` container) and is not part of the default Docker stack.

### Project Isolation

Each project gets namespaced collections in Qdrant:

- `{project}_codebase` - indexed source code
- `{project}_docs` - documentation
- `{project}_confluence` - Confluence pages
- `{project}_agent_memory` - durable agent memory (decisions, insights, ADRs)
- `{project}_memory_pending` - quarantine for auto-captured memories awaiting promotion/rejection

### Memory Architecture (human-inspired)

```
Tool Call → Sensory Buffer (Redis Stream, 24h TTL)
         → Working Memory (Redis Hash, 20 slots, salience >= 0.5)
         → Consolidation (LLM pipeline, async via BullMQ worker)
         → LTM: Episodic (7d decay) + Semantic (30-60d decay)
         → Governance: quarantine → promote/reject → durable
         → Retrieval: vector search + Ebbinghaus weighting + spreading activation
```

### Service Layer (rag-api/src/services/)

| Service                  | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `vector-store.ts`        | Qdrant client, collection management              |
| `embedding.ts`           | Embedding generation (Ollama/OpenAI/BGE-M3)       |
| `llm.ts`                 | LLM completions (Ollama/OpenAI/Anthropic)         |
| `indexer.ts`             | Code chunking and indexing                        |
| `memory.ts`              | Agent memory (ADRs, patterns, tech debt)          |
| `memory-ltm.ts`          | Long-term memory (episodic/semantic + Ebbinghaus) |
| `memory-governance.ts`   | Quarantine, promotion, adaptive thresholds        |
| `sensory-buffer.ts`      | Redis Streams event capture                       |
| `working-memory.ts`      | Attention filter, capacity management             |
| `consolidation-agent.ts` | 7-step LLM pipeline (session → LTM)               |
| `session-context.ts`     | Session lifecycle, auto-continuity                |
| `confluence.ts`          | Confluence integration                            |

### MCP Server Tools

The MCP server registers **32 tools, 0 hidden** (`MCP_PROFILE=full`, the default; `lite` registers a 6-tool subset). The canonical surface:

- **Search:** `hybrid_search` (the one retrieval tool — hybrid by default, `mode: "navigate"` for a file/symbol map), `find_symbol`, `search_graph`, `search_docs`, `get_project_stats`
- **Indexing:** `index_codebase`, `get_index_status`
- **Memory:** `remember`, `recall`, `list_memories`, `forget`, `batch_remember`, `review_memories`, `promote_memory` (governance maintenance runs on the rag-api scheduler — `scheduled-maintenance.ts` — not via a tool)
- **Architecture:** `record_adr`, `get_adrs`, `record_pattern`, `get_patterns`, `record_tech_debt`, `get_tech_debt`
- **Context/setup:** `context_briefing`, `setup_project`; **Session:** `start_session`, `end_session`
- **Confluence (4):** `search_confluence`, `index_confluence`, `get_confluence_status`, `list_confluence_spaces`
- **Agents/quality:** `run_agent`, `tribunal_debate`, `get_agent_types`, `get_quality_report`

The registered count is asserted by `mcp-server/src/__tests__/tool-registration.test.ts` — change it in the same PR as any tool addition/deletion.

**DB schema knowledge** has no dedicated tools (the 8 `record_table`-style tools were removed in 0.5.0 — they were thin `remember`/`recall` wrappers). Use the tag convention instead, same as the reka-plugin `/reka:code` DB flow: save schema facts with `remember(type: "context", tags: ["db-schema", "<table>"])` and rules/constraints with `remember(type: "decision", tags: ["db-rule", "<table>"])`; before schema changes, `recall(query: "<table name> schema")` — include the table name and those tags in the query. Existing DB memories stay recallable (no migration needed).

## Configuration

### Authentication

API key auth with deny-by-default. Keys stored in `data/keys.json` (format: `rk_{project}_{hex}`).
Set `ALLOW_ANONYMOUS=true` for local dev without keys.

Generate a key: `node -e "const {generateKey}=require('./dist/middleware/auth'); console.log(generateKey('myproject','label'))"`

### Environment Variables (rag-api/.env)

Key settings:

- `EMBEDDING_PROVIDER`: `ollama` (used everywhere) | `bge-m3-server` | `openai`
- `OLLAMA_EMBEDDING_MODEL`: `qwen3-embedding:4b` (both contexts below)
- `LLM_PROVIDER`: `ollama` | `openai` | `anthropic`
- `ANTHROPIC_MODEL`: `claude-sonnet-4-6` (complex tasks)
- `CONSOLIDATION_ENABLED`: `true` — async consolidation via BullMQ worker
- `ALLOW_ANONYMOUS`: `true` — skip auth (dev only)

There are **two distinct configs** — do not mix their values:

| Setting        | Local dev (`rag-api/.env`)                 | Docker prod (`docker/docker-compose.yml`, `reka-api`) |
| -------------- | ------------------------------------------ | ----------------------------------------------------- |
| `OLLAMA_MODEL` | `qwen3.5:27b`                              | `qwen3.5:9b`                                          |
| `VECTOR_SIZE`  | `1024` (qwen3-embedding:4b, MRL-truncated) | `2560` (qwen3-embedding:4b, full dims)                |

Other `VECTOR_SIZE` values: 1536 (OpenAI), 1024 (BGE-M3, if you opt into it).

### MCP Server Config (in consumer project's .mcp.json)

```json
{
  "mcpServers": {
    "rag": {
      "command": "npx",
      "args": ["-y", "@getreka/mcp@latest"],
      "env": {
        "PROJECT_NAME": "myproject",
        "PROJECT_PATH": "/path/to/myproject",
        "RAG_API_URL": "http://localhost:3100",
        "REKA_API_KEY": "rk_myproject_..."
      }
    }
  }
}
```

## Ports

| Service | Port                                              |
| ------- | ------------------------------------------------- |
| RAG API | 3100                                              |
| Qdrant  | 6333 (REST), 6334 (gRPC)                          |
| Ollama  | 11434                                             |
| Redis   | 6380                                              |
| BGE-M3  | 8080 (optional reranker — not running by default) |

## RAG Integration

### Before non-trivial changes:

Call `context_briefing` when a change spans multiple files, touches shared services/exports, or when prior decisions (patterns/ADRs) could affect the approach. Skip it for mechanical single-line edits (typos, renames, version bumps).

```
context_briefing(task: "describe your change", files: ["path/to/file.ts"])
```

### After meaningful work:

Call `remember` once per work item, and only when you learned something non-obvious — a decision, a gotcha, or a new procedure. Don't save memories for mechanical changes (they just pollute recall).

```
remember(content: "summary of what changed and why")
```

### After architectural decisions:

```
record_adr(title, context, decision)
```

### Workflows (plugin commands):

- `/reka:start` — session init with cache + profile
- `/reka:end` — save context + end session (consolidation runs async)
- `/reka:code` — RAG-powered coding workflow
- `/reka:investigate` — deep codebase investigation (no code changes)
- `/reka:review` — architecture-aware code review
- `/reka:arch` — record/analyze architecture decisions (ADRs)
- `/reka:debate` — adversarial debate for complex decisions
- `/reka:onboard` — onboard new project to RAG
- `/reka:memory-review` — triage quarantine, check memory health

### Search priority:

1. **Grep/Glob** — exact strings, file names, known symbols
2. **find_symbol** — function/class/type lookup by name
3. **hybrid_search** — semantic/conceptual ("how does X work")
4. **search_graph** — dependencies, blast radius
5. **context_briefing** — does all above in parallel (before code changes)
