# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
   ┌─────────┐      ┌───────────┐      ┌───────────┐
   │ Qdrant  │      │  Ollama   │      │  BGE-M3   │
   │ :6333   │      │  :11434   │      │  :8080    │
   │ vectors │      │  LLM      │      │ embeddings│
   └─────────┘      └───────────┘      └───────────┘
```

### Project Isolation

Each project gets namespaced collections in Qdrant:

- `{project}_codebase` - indexed source code
- `{project}_docs` - documentation
- `{project}_confluence` - Confluence pages
- `{project}_memory` - agent memory (decisions, insights, ADRs)

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
| `embedding.ts`           | Embedding generation (BGE-M3/Ollama/OpenAI)       |
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

The MCP server exposes RAG capabilities as tools for AI assistants:

- `search_codebase`, `ask_codebase`, `explain_code`, `find_feature`
- `index_codebase`, `get_index_status`, `get_project_stats`
- `remember`, `recall`, `record_adr`, `get_patterns`, etc.

## Configuration

### Authentication

API key auth with deny-by-default. Keys stored in `data/keys.json` (format: `rk_{project}_{hex}`).
Set `ALLOW_ANONYMOUS=true` for local dev without keys.

Generate a key: `node -e "const {generateKey}=require('./dist/middleware/auth'); console.log(generateKey('myproject','label'))"`

### Environment Variables (rag-api/.env)

Key settings:

- `EMBEDDING_PROVIDER`: `bge-m3-server` | `ollama` | `openai`
- `LLM_PROVIDER`: `ollama` | `openai` | `anthropic`
- `OLLAMA_MODEL`: `qwen3.5:9b` (utility), `ANTHROPIC_MODEL`: `claude-sonnet-4-6` (complex)
- `VECTOR_SIZE`: 1024 (BGE-M3), 1536 (OpenAI), 768 (Ollama nomic)
- `CONSOLIDATION_ENABLED`: `true` — async consolidation via BullMQ worker
- `ALLOW_ANONYMOUS`: `true` — skip auth (dev only)

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

| Service | Port                     |
| ------- | ------------------------ |
| RAG API | 3100                     |
| Qdrant  | 6333 (REST), 6334 (gRPC) |
| Ollama  | 11434                    |
| BGE-M3  | 8080                     |
| Redis   | 6380                     |

## RAG Integration

### Before ANY code change (REQUIRED):

```
context_briefing(task: "describe your change", files: ["path/to/file.ts"])
```

### After completing changes (REQUIRED):

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
