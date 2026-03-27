# Contributing to Reka

Thank you for your interest in contributing to Reka! This guide covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)
- [Good First Issues](#good-first-issues)

---

## Development Setup

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Git
- (Optional) NVIDIA GPU + drivers for Ollama acceleration

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/reka.git
cd reka
```

### 2. Start Infrastructure

```bash
docker compose -f docker/docker-compose.yml up -d qdrant redis bge-m3
```

### 3. Build Packages

```bash
# API server
cd rag-api
npm install
cp .env.example .env   # Edit as needed
npm run build

# MCP server
cd ../mcp-server
npm install
npm run build

# Dashboard (optional)
cd ../dashboard
npm install
```

### 4. Run in Development

```bash
# Terminal 1: API server with hot reload
cd rag-api && npm run dev

# Terminal 2: Dashboard dev server (optional)
cd dashboard && npm run dev
```

### 5. Run Tests

```bash
# API tests
cd rag-api && npm test

# MCP server tests
cd mcp-server && npm test

# With coverage
cd rag-api && npm run test:coverage
```

---

## Project Structure

```
reka/
├── rag-api/                 # Core API server (Express + TypeScript)
│   ├── src/
│   │   ├── server.ts        # Entry point
│   │   ├── config.ts        # Configuration
│   │   ├── routes/          # Express route handlers
│   │   ├── services/        # Business logic (singletons)
│   │   │   ├── vector-store.ts
│   │   │   ├── embedding.ts
│   │   │   ├── llm.ts
│   │   │   ├── indexer.ts
│   │   │   ├── memory.ts
│   │   │   ├── graph-store.ts
│   │   │   ├── symbol-index.ts
│   │   │   ├── memory-governance.ts
│   │   │   ├── consolidation-agent.ts
│   │   │   └── ...
│   │   ├── utils/
│   │   │   └── validation.ts # Zod schemas (centralized)
│   │   └── evals/           # Evaluation framework
│   └── package.json
├── mcp-server/              # MCP server (per-project instance)
│   ├── src/
│   │   ├── index.ts         # Entry point + tool registration
│   │   ├── tools/           # Tool definitions (createXxxTools())
│   │   └── tool-middleware.ts
│   └── package.json
├── dashboard/               # Vue 3 + Vite web UI
├── docker/                  # Docker Compose configurations
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── docker-compose.prod.yml
├── docs/                    # Documentation
└── scripts/                 # Utility scripts
```

### Key Patterns

- **Services** are singleton classes, exported as module-level instances
- **Routes** use `asyncHandler` wrapper + `validate` middleware (Zod)
- **MCP tools** follow the pattern: `createXxxTools()` returns `{tools, handlers}`
- **Validation schemas** are centralized in `rag-api/src/utils/validation.ts`

---

## Code Style

### TypeScript

- Strict mode enabled
- Use explicit return types on exported functions
- Prefer `interface` over `type` for object shapes
- Use `async/await` over raw Promises

### Formatting

```bash
# Format code
cd rag-api && npm run format

# Lint
cd rag-api && npm run lint

# Auto-fix lint issues
cd rag-api && npm run lint:fix
```

### Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | `kebab-case.ts` | `memory-governance.ts` |
| Classes | `PascalCase` | `MemoryGovernance` |
| Functions | `camelCase` | `consolidateMemories()` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_BATCH_SIZE` |
| Interfaces | `PascalCase` | `MemoryEntry` |
| MCP tools | `snake_case` | `search_codebase` |

### Commit Messages

Follow conventional commits:

```
feat: add spreading activation to recall
fix: handle empty embeddings in batch upsert
docs: update MCP tool reference
refactor: extract parser registry from indexer
test: add memory governance unit tests
chore: update dependencies
```

---

## Making Changes

### Branch Naming

```
feat/short-description
fix/issue-number-description
docs/what-changed
refactor/what-changed
```

### Before You Code

1. Check existing issues and PRs to avoid duplicate work
2. For significant changes, open an issue first to discuss the approach
3. For small fixes (typos, docs, obvious bugs), go straight to a PR

### Testing

- Add tests for new features and bug fixes
- Tests use Vitest and live in `__tests__/` directories or `*.test.ts` files
- Run the full suite before submitting: `npm test`
- For services that depend on external systems (Qdrant, Redis), use mocks

---

## Pull Request Process

### 1. Create Your PR

```bash
git checkout -b feat/my-feature
# Make changes, commit
git push -u origin feat/my-feature
# Open PR on GitHub
```

### 2. PR Requirements

- [ ] Tests pass (`npm test` in affected packages)
- [ ] Linting passes (`npm run lint`)
- [ ] TypeScript compiles (`npm run build`)
- [ ] PR description explains **what** and **why**
- [ ] Breaking changes are documented

### 3. PR Title Format

Use the same conventional commit format:

```
feat: add memory expiration policies
fix: prevent duplicate graph edges on re-index
docs: add self-hosting guide for ARM64
```

### 4. Review Process

- A maintainer will review your PR, usually within 48 hours
- Address review feedback by pushing new commits (don't force-push)
- Once approved, a maintainer will merge

---

## Issue Guidelines

### Bug Reports

Use the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs actual behavior
- Reka version, OS, Docker version
- Relevant logs (from `docker compose logs` or API output)

### Feature Requests

Use the **Feature Request** template. Include:
- Problem statement (what are you trying to do?)
- Proposed solution
- Alternatives you considered

### Issue Labels

| Label | Meaning |
|-------|---------|
| `good first issue` | Scoped, well-documented, good for newcomers |
| `help wanted` | Maintainers want community help |
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `documentation` | Docs improvements |
| `performance` | Performance-related |
| `memory` | Memory system (governance, consolidation, LTM) |
| `search` | Search and retrieval |
| `mcp` | MCP server and tools |
| `indexing` | Code indexing and parsing |
| `infrastructure` | Docker, CI/CD, deployment |

---

## Good First Issues

We maintain a curated list of good first issues. These are:

- **Scoped**: Clear boundaries, no rabbit holes
- **Documented**: Description includes context, approach hints, and relevant files
- **Tested**: Clear criteria for "done"

Look for the [`good first issue`](https://github.com/AKE-REKA/reka/labels/good%20first%20issue) label.

Examples of good first issues:
- Add a new file parser (e.g., `.vue`, `.svelte`)
- Add a new MCP tool that wraps an existing API endpoint
- Improve error messages for common configuration mistakes
- Add unit tests for an untested service method
- Fix a documented bug with clear reproduction steps

---

## Questions?

- Open a [Discussion](https://github.com/AKE-REKA/reka/discussions) for questions
- Join [Discord](https://discord.gg/reka) for real-time help
- Tag `@maintainers` in your issue or PR if you're stuck

Thank you for contributing!
