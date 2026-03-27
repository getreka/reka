<!-- LOGO -->
<div align="center">
  <img src="docs/assets/reka-logo.svg" alt="Reka" width="200" />

  <h1>Reka</h1>

  <p><strong>Memory that flows. Knowledge that stays.</strong></p>

  <p>Self-hosted RAG infrastructure for AI coding assistants.<br/>Multi-project isolation. Memory governance. MCP native. Zero vendor lock-in.</p>

  <p>
    <a href="https://github.com/AKE-REKA/reka/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/AKE-REKA/reka/ci.yml?branch=main&style=flat-square&label=build" alt="Build Status" /></a>
    <a href="https://www.npmjs.com/package/@reka/mcp-server"><img src="https://img.shields.io/npm/v/@reka/mcp-server?style=flat-square&color=cb3837&label=npm" alt="npm version" /></a>
    <a href="https://github.com/AKE-REKA/reka/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License" /></a>
    <a href="https://discord.gg/reka"><img src="https://img.shields.io/discord/000000000?style=flat-square&color=5865F2&label=discord" alt="Discord" /></a>
    <a href="https://github.com/AKE-REKA/reka/stargazers"><img src="https://img.shields.io/github/stars/AKE-REKA/reka?style=flat-square&color=f5c542" alt="Stars" /></a>
  </p>

  <p>
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="https://docs.reka.dev">Docs</a> &middot;
    <a href="https://discord.gg/reka">Discord</a> &middot;
    <a href="https://github.com/AKE-REKA/reka/issues">Issues</a>
  </p>
</div>

---

## What is Reka?

Reka is a self-hosted RAG platform that gives your AI coding assistant persistent memory and deep codebase knowledge. It connects to Claude Code, Cursor, Windsurf, or any MCP-compatible client through a single MCP server -- one shared backend serving all your projects without context conflicts.

Every project gets its own isolated vector namespace. Every memory goes through governance. Everything runs on your hardware.

<!-- DEMO -->
<div align="center">
  <img src="docs/assets/demo.gif" alt="Reka demo" width="720" />
  <br />
  <em>Index a codebase. Ask questions. Build memory. All from your terminal.</em>
</div>

---

## Why Reka?

- **Your code stays yours.** Fully self-hosted. Embeddings run locally with BGE-M3. LLM via Ollama or any provider you choose. No data leaves your machine.

- **Memory that actually works.** Not just a vector dump. Reka implements human-memory-inspired architecture: sensory buffer, consolidation, episodic/semantic long-term memory, and spreading activation. Memories are governed, deduplicated, and evolve over time.

- **One backend, all projects.** Each project gets isolated namespaces in Qdrant (`{project}_codebase`, `{project}_memory`, `{project}_graph`). Switch between codebases without cross-contamination. Share infrastructure without sharing context.

---

## Quick Start

```bash
# 1. Clone and start infrastructure
git clone https://github.com/AKE-REKA/reka.git && cd reka
docker compose -f docker/docker-compose.yml up -d

# 2. Build the MCP server
cd mcp-server && npm install && npm run build

# 3. Add to your project's .mcp.json (see "MCP Setup" below)
```

That's it. Three commands to persistent memory for your AI assistant.

---

## Features

| Category | Feature | Status |
|----------|---------|--------|
| **Search** | Hybrid search (vector + keyword) | :white_check_mark: |
| | Code graph traversal (imports, dependencies) | :white_check_mark: |
| | Symbol index (functions, classes, types) | :white_check_mark: |
| | Smart dispatch (LLM-routed parallel lookups) | :white_check_mark: |
| **Memory** | Structured memory (ADRs, patterns, tech debt) | :white_check_mark: |
| | Memory governance (quarantine, promotion, decay) | :white_check_mark: |
| | Memory consolidation (merge duplicates, evolve) | :white_check_mark: |
| | Spreading activation (associative recall) | :white_check_mark: |
| | Episodic and semantic long-term memory | :white_check_mark: |
| **Indexing** | Multi-language code parsing (TS, Python, Go, Rust, Java, ...) | :white_check_mark: |
| | Incremental indexing (hash-based change detection) | :white_check_mark: |
| | Confluence integration | :white_check_mark: |
| | Documentation indexing | :white_check_mark: |
| **Platform** | Multi-project isolation | :white_check_mark: |
| | MCP server (Claude Code, Cursor, Windsurf) | :white_check_mark: |
| | REST API | :white_check_mark: |
| | Vue 3 dashboard | :white_check_mark: |
| | Prometheus + Grafana monitoring | :white_check_mark: |
| | OpenTelemetry tracing (Jaeger) | :white_check_mark: |
| **LLM** | Ollama (local, any model) | :white_check_mark: |
| | OpenAI | :white_check_mark: |
| | Anthropic Claude | :white_check_mark: |
| | Hybrid routing (local for utility, cloud for complex) | :white_check_mark: |
| **Embedding** | BGE-M3 (local, 1024d, multilingual) | :white_check_mark: |
| | OpenAI embeddings | :white_check_mark: |
| | Ollama embeddings | :white_check_mark: |

---

## Architecture

```
 Your IDE / Terminal
 ┌──────────────────────────────────────────────────────┐
 │  Claude Code / Cursor / Windsurf / Any MCP Client    │
 └──────────────────────┬───────────────────────────────┘
                        │ MCP Protocol (stdio)
                        ▼
 ┌──────────────────────────────────────────────────────┐
 │  Reka MCP Server           (per-project instance)    │
 │  ~35 tools: search, memory, indexing, agents         │
 └──────────────────────┬───────────────────────────────┘
                        │ HTTP + X-Project-Name header
                        ▼
 ┌──────────────────────────────────────────────────────┐
 │  Reka API Server                          :3100      │
 │                                                      │
 │  Routes     Services          Memory                 │
 │  ┌───────┐  ┌──────────────┐  ┌───────────────────┐ │
 │  │search │  │vector-store  │  │sensory-buffer     │ │
 │  │memory │  │embedding     │  │consolidation-agent│ │
 │  │agents │  │llm (hybrid)  │  │memory-governance  │ │
 │  │index  │  │indexer       │  │spreading-activation│ │
 │  │review │  │graph-store   │  │memory-ltm         │ │
 │  │quality│  │symbol-index  │  │reconsolidation    │ │
 │  └───────┘  └──────────────┘  └───────────────────┘ │
 └───────┬──────────┬──────────┬──────────┬─────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌───▼──┐
    │ Qdrant │ │ Ollama │ │ BGE-M3 │ │Redis │
    │ :6333  │ │ :11434 │ │ :8080  │ │:6380 │
    │vectors │ │  LLM   │ │embeddings│ │cache │
    └────────┘ └────────┘ └────────┘ └──────┘
```

**Project isolation** -- each project gets its own namespaced collections:
```
myapp_codebase    myapp_memory    myapp_graph    myapp_symbols
other_codebase    other_memory    other_graph    other_symbols
```

---

## Comparison

| | **Reka** | Cursor Memory | Cody (Sourcegraph) | Continue.dev | Greptile |
|---|---|---|---|---|---|
| Self-hosted | :white_check_mark: Fully | :x: Cloud | :warning: Partial | :white_check_mark: | :x: Cloud |
| Memory governance | :white_check_mark: Full lifecycle | :x: | :x: | :x: | :x: |
| Multi-project | :white_check_mark: Isolated | :x: Per-workspace | :white_check_mark: | :warning: Limited | :white_check_mark: |
| Code graph | :white_check_mark: Import/dep graph | :x: | :white_check_mark: | :x: | :white_check_mark: |
| MCP native | :white_check_mark: | :x: | :x: | :white_check_mark: | :x: |
| LLM choice | :white_check_mark: Any (Ollama/OpenAI/Anthropic) | :x: Locked | :x: Locked | :white_check_mark: | :x: Locked |
| Embedding choice | :white_check_mark: Any (BGE-M3/OpenAI/Ollama) | :x: Locked | :x: Locked | :warning: Limited | :x: Locked |
| Data privacy | :white_check_mark: 100% local | :x: Cloud | :warning: | :white_check_mark: | :x: Cloud |
| Open source | :white_check_mark: AGPL-3.0 | :x: | :white_check_mark: Apache | :white_check_mark: Apache | :x: |
| Cost | :white_check_mark: Free | :moneybag: $/seat | :moneybag: $/seat | :white_check_mark: Free | :moneybag: $/repo |

---

## Installation

### Docker (recommended)

```bash
git clone https://github.com/AKE-REKA/reka.git
cd reka

# Start all services
docker compose -f docker/docker-compose.yml up -d

# Verify everything is healthy
curl http://localhost:3100/health
curl http://localhost:6333/healthz
curl http://localhost:8080/health
```

**Requirements:** Docker, 8GB+ RAM (16GB recommended), NVIDIA GPU optional (for Ollama acceleration).

### Manual Installation

```bash
git clone https://github.com/AKE-REKA/reka.git
cd reka

# Start dependencies (Qdrant, Redis -- bring your own Ollama)
docker compose -f docker/docker-compose.yml up -d qdrant redis bge-m3

# Build and start the API server
cd rag-api
npm install
cp .env.example .env    # Edit with your settings
npm run build
npm start               # Runs on :3100

# Build the MCP server
cd ../mcp-server
npm install
npm run build
```

### Optional: Monitoring Stack

```bash
docker compose -f docker/docker-compose.yml --profile monitoring up -d
# Grafana: http://localhost:3200 (admin/admin)
# Prometheus: http://localhost:9090
# Jaeger: http://localhost:16686
```

---

## Configuration

Essential environment variables for `rag-api/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `bge-m3-server` | Embedding backend: `bge-m3-server`, `ollama`, `openai` |
| `LLM_PROVIDER` | `ollama` | LLM backend: `ollama`, `openai`, `anthropic` |
| `OLLAMA_MODEL` | `qwen3.5:35b` | Ollama model for completions |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `BGE_M3_URL` | `http://localhost:8080` | BGE-M3 embedding server URL |
| `REDIS_URL` | `redis://localhost:6380` | Redis cache URL |
| `OPENAI_API_KEY` | -- | Required if using OpenAI provider |
| `ANTHROPIC_API_KEY` | -- | Required if using Anthropic provider |
| `CONSOLIDATION_ENABLED` | `true` | Enable memory consolidation agent |
| `GRAPH_RECALL_ENABLED` | `true` | Enable code graph in recall |

---

## MCP Setup

Add Reka to any MCP-compatible client by configuring `.mcp.json` in your project root:

### Claude Code

```json
{
  "mcpServers": {
    "reka": {
      "command": "node",
      "args": ["/path/to/reka/mcp-server/dist/index.js"],
      "env": {
        "PROJECT_NAME": "myproject",
        "PROJECT_PATH": "/path/to/myproject",
        "RAG_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

### Cursor / Windsurf

Same configuration -- place in your project's `.mcp.json` or configure in the IDE's MCP settings panel.

### Available Tools (~35 core)

| Tool | Description |
|------|-------------|
| `search_codebase` | Vector search across indexed code |
| `hybrid_search` | Combined vector + keyword search |
| `find_symbol` | Fast lookup of functions, classes, types |
| `search_graph` | Traverse import/dependency graph |
| `ask_codebase` | Natural language Q&A over code (RAG) |
| `explain_code` | Explain a code snippet in context |
| `context_briefing` | Parallel multi-strategy lookup before changes |
| `smart_dispatch` | LLM-routed parallel lookups |
| `remember` | Store a memory (decision, insight, pattern) |
| `recall` | Retrieve relevant memories |
| `record_adr` | Record an architecture decision |
| `record_pattern` | Record a recurring code pattern |
| `index_codebase` | Index or re-index the project |
| `start_session` / `end_session` | Session lifecycle with auto-continuity |
| `run_agent` | Launch an autonomous sub-agent |

---

## Dashboard

Reka includes a Vue 3 web dashboard for monitoring and exploration.

```bash
cd dashboard && npm install && npm run dev
# Open http://localhost:3000
```

Features: collection browser, memory explorer, search playground, indexing status, system health.

---

## Documentation

| Resource | Link |
|----------|------|
| Getting Started | [docs.reka.dev/getting-started](https://docs.reka.dev/getting-started) |
| Architecture Guide | [docs.reka.dev/architecture](https://docs.reka.dev/architecture) |
| Memory System | [docs.reka.dev/memory](https://docs.reka.dev/memory) |
| API Reference | [docs.reka.dev/api](https://docs.reka.dev/api) |
| MCP Tools Reference | [docs.reka.dev/mcp-tools](https://docs.reka.dev/mcp-tools) |
| Self-Hosting Guide | [docs.reka.dev/self-hosting](https://docs.reka.dev/self-hosting) |
| Configuration | [docs.reka.dev/configuration](https://docs.reka.dev/configuration) |

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR process.

**Good first issues** are labeled [`good first issue`](https://github.com/AKE-REKA/reka/labels/good%20first%20issue) -- these are scoped, well-documented tasks perfect for new contributors.

---

## Community

- **Discord** -- [discord.gg/reka](https://discord.gg/reka) -- Ask questions, share setups, get help
- **GitHub Discussions** -- [Discussions](https://github.com/AKE-REKA/reka/discussions) -- Feature requests, architecture RFCs
- **Twitter/X** -- [@rekadev](https://twitter.com/rekadev) -- Updates and announcements
- **Blog** -- [reka.dev/blog](https://reka.dev/blog) -- Deep dives and release notes

---

## License

Reka is open source under the [AGPL-3.0 License](LICENSE).

For commercial/enterprise licensing, contact [enterprise@reka.dev](mailto:enterprise@reka.dev).

---

<div align="center">

**If Reka is useful to you, consider giving it a star.** :star:

[![Star History Chart](https://api.star-history.com/svg?repos=AKE-REKA/reka&type=Date)](https://star-history.com/#AKE-REKA/reka&Date)

</div>
