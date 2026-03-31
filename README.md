<div align="center">

  <h1>Reka</h1>

  <p><strong>Memory that flows. Knowledge that stays.</strong></p>

  <p>Self-hosted RAG infrastructure for AI coding assistants.<br/>Give Claude Code, Cursor, or Windsurf persistent memory across sessions.</p>

  <p>
    <a href="https://www.npmjs.com/package/@getreka/mcp"><img src="https://img.shields.io/npm/v/@getreka/mcp?style=flat-square&color=cb3837&label=@getreka/mcp" alt="npm" /></a>
    <a href="https://www.npmjs.com/package/@getreka/cli"><img src="https://img.shields.io/npm/v/@getreka/cli?style=flat-square&color=cb3837&label=@getreka/cli" alt="npm" /></a>
    <a href="https://github.com/getreka/reka/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-BSL--1.1-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/getreka/reka/stargazers"><img src="https://img.shields.io/github/stars/getreka/reka?style=flat-square&color=f5c542" alt="Stars" /></a>
  </p>

  <p>
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="#how-it-works">How It Works</a> &middot;
    <a href="#features">Features</a> &middot;
    <a href="https://getreka.dev">Website</a> &middot;
    <a href="https://github.com/getreka/reka/issues">Issues</a>
  </p>
</div>

---

## The Problem

Your AI coding assistant forgets everything between sessions. Every new conversation starts from zero -- no memory of past decisions, no knowledge of your architecture, no recall of what was already tried and failed.

**Reka fixes this.** It gives your AI assistant persistent memory, semantic code search, and a knowledge graph of your codebase -- all running on your machine.

---

## Quick Start

Three commands. Under 5 minutes.

```bash
# 1. Start the infrastructure
git clone https://github.com/getreka/reka.git
cd reka && docker-compose up -d

# 2. Initialize your project (generates API key + .mcp.json)
npx @getreka/cli init --project my-app
```

That's it. Open your AI assistant -- it now has memory.

### Try the demo (no install needed)

```bash
npx @getreka/cli init --demo --project my-app
```

This connects to a live Reka instance so you can try memory, search, and indexing before deploying your own. Demo data may be reset periodically.

### What `reka init` does

1. Creates an API key mapped to your project
2. Writes `.mcp.json` with the correct MCP server config
3. Your AI assistant auto-discovers the MCP server on next launch

The generated `.mcp.json`:

```json
{
  "mcpServers": {
    "reka": {
      "command": "npx",
      "args": ["-y", "@getreka/mcp"],
      "env": {
        "REKA_API_KEY": "rk_myapp_a3f8b2..."
      }
    }
  }
}
```

> **One API key = one project.** No extra headers or config needed. The key tells Reka which project you're working on.

---

## How It Works

```
 Claude Code / Cursor / Windsurf
        │
        │ MCP Protocol
        ▼
 @getreka/mcp            ← npm package, zero config
        │
        │ HTTP + API Key
        ▼
 Reka API (:3100)        ← Express server
        │
   ┌────┼────┬────┐
   ▼    ▼    ▼    ▼
 Qdrant Ollama BGE-M3 Redis
 vectors  LLM  embed  cache
```

Each project gets isolated collections in Qdrant:

- `myapp_codebase` -- indexed source code
- `myapp_memory` -- decisions, patterns, insights
- `myapp_graph` -- import/dependency relationships
- `myapp_symbols` -- function/class/type index

No cross-contamination between projects. One backend serves them all.

---

## Features

### Search

- **Hybrid search** -- vector similarity + keyword matching
- **Code graph** -- traverse imports, dependencies, blast radius
- **Symbol index** -- instant lookup of functions, classes, types
- **Smart dispatch** -- LLM routes your query to the best search strategy

### Memory

- **Persistent memory** -- decisions, patterns, ADRs survive across sessions
- **Memory governance** -- quarantine, promotion, decay (not everything deserves permanence)
- **Consolidation** -- duplicate memories merge and evolve over time
- **Spreading activation** -- associative recall finds related memories

### Indexing

- **Multi-language** -- TypeScript, Python, Go, Rust, Java, C#, and more
- **Incremental** -- hash-based change detection, only re-indexes what changed
- **Confluence** -- index your team's docs alongside code
- **Knowledge graph** -- auto-extracts import/export relationships

### Platform

- **MCP native** -- works with Claude Code, Cursor, Windsurf out of the box
- **35 tools** -- search, memory, indexing, agents, architecture, review
- **Dashboard** -- Vue 3 web UI for memory review and analytics
- **Monitoring** -- Prometheus + Grafana + Jaeger (optional)

### LLM & Embedding

- **Fully local** -- Ollama + BGE-M3, zero API keys needed
- **Or hybrid** -- local for fast tasks, Claude/GPT-4 for complex analysis
- **Your choice** -- Ollama, OpenAI, or Anthropic for LLM; BGE-M3, OpenAI, or Ollama for embeddings

---

## Deployment Options

|                    | Self-Hosted              | Hybrid                        | Cloud                |
| ------------------ | ------------------------ | ----------------------------- | -------------------- |
| **Price**          | Free                     | $12/dev/mo                    | $35/dev/mo           |
| **Infrastructure** | Your machine             | Local + Reka Cloud            | Fully managed        |
| **Data residency** | 100% local               | Code local, vectors in cloud  | Cloud                |
| **Setup**          | `docker-compose up`      | Coming soon                   | Coming soon          |
| **Best for**       | Privacy-first, solo devs | Teams wanting zero-ops search | Enterprise, no infra |

Self-hosted is the full platform with zero limitations. Hybrid and Cloud are coming soon -- [join the waitlist](https://getreka.dev).

---

## Requirements

| Component | Minimum      | Recommended                    |
| --------- | ------------ | ------------------------------ |
| Docker    | 24+          | Latest                         |
| RAM       | 8 GB         | 16 GB                          |
| Node.js   | 22+          | Latest LTS                     |
| Disk      | ~2 GB        | SSD recommended                |
| GPU       | Not required | NVIDIA for Ollama acceleration |

---

## Configuration

Key environment variables for `rag-api/.env`:

| Variable             | Default                  | Description                         |
| -------------------- | ------------------------ | ----------------------------------- |
| `EMBEDDING_PROVIDER` | `bge-m3-server`          | `bge-m3-server`, `ollama`, `openai` |
| `LLM_PROVIDER`       | `ollama`                 | `ollama`, `openai`, `anthropic`     |
| `OLLAMA_MODEL`       | `qwen3.5:35b`            | Model for LLM completions           |
| `QDRANT_URL`         | `http://localhost:6333`  | Vector database                     |
| `REDIS_URL`          | `redis://localhost:6380` | Cache (optional, recommended)       |
| `OPENAI_API_KEY`     | --                       | Required if using OpenAI            |
| `ANTHROPIC_API_KEY`  | --                       | Required if using Anthropic         |

Default config runs fully local -- no API keys needed.

---

## MCP Tools

Reka exposes ~35 tools to your AI assistant. The most used:

| Tool                            | What it does                                |
| ------------------------------- | ------------------------------------------- |
| `search_codebase`               | Semantic search across your indexed code    |
| `hybrid_search`                 | Vector + keyword search combined            |
| `find_symbol`                   | Fast lookup: functions, classes, types      |
| `search_graph`                  | Traverse imports, find dependencies         |
| `ask_codebase`                  | Natural language Q&A over your code         |
| `context_briefing`              | Multi-strategy lookup before making changes |
| `remember`                      | Store a decision, insight, or pattern       |
| `recall`                        | Retrieve relevant memories                  |
| `record_adr`                    | Record an architecture decision             |
| `index_codebase`                | Index or re-index the project               |
| `start_session` / `end_session` | Session lifecycle with continuity           |
| `run_agent`                     | Launch an autonomous sub-agent              |

---

## Dashboard

```bash
cd dashboard && npm install && npm run dev
# Open http://localhost:3000
```

Memory explorer, search playground, project analytics, indexing status, system health.

---

## Comparison

|                   | **Reka**       | Cursor Memory | Cody (Sourcegraph) | Continue.dev | Greptile   |
| ----------------- | -------------- | ------------- | ------------------ | ------------ | ---------- |
| Self-hosted       | Fully          | Cloud only    | Partial            | Yes          | Cloud only |
| Memory governance | Full lifecycle | No            | No                 | No           | No         |
| Multi-project     | Isolated       | Per-workspace | Yes                | Limited      | Yes        |
| Code graph        | Yes            | No            | Yes                | No           | Yes        |
| MCP native        | Yes            | No            | No                 | Yes          | No         |
| LLM choice        | Any            | Locked        | Locked             | Any          | Locked     |
| Data privacy      | 100% local     | Cloud         | Partial            | Local        | Cloud      |
| Cost              | Free           | $/seat        | $/seat             | Free         | $/repo     |

---

## Project Structure

```
reka/
├── rag-api/          # Core API server (Express, TypeScript)
├── mcp-server/       # MCP server (@getreka/mcp)
├── cli/              # CLI tool (@getreka/cli)
├── dashboard/        # Web dashboard (Vue 3)
├── docker/           # Dockerfiles, Grafana, Prometheus configs
└── docker-compose.yml
```

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

Good first issues are labeled [`good first issue`](https://github.com/getreka/reka/labels/good%20first%20issue).

---

## License

Reka is source-available under the [Business Source License 1.1](LICENSE).

- **Self-host freely** -- no restrictions for internal use
- **Build integrations** -- plugins, extensions, custom tools
- **Converts to Apache 2.0** after 3 years

The only restriction: you cannot offer Reka as a managed service competing with [Reka Cloud](https://getreka.dev).

---

<div align="center">
  <p><strong>Give your AI assistant the memory it deserves.</strong></p>
  <p>
    <a href="#quick-start">Get started</a> &middot;
    <a href="https://getreka.dev">getreka.dev</a> &middot;
    <a href="https://github.com/getreka/reka/issues">Report an issue</a>
  </p>
</div>
