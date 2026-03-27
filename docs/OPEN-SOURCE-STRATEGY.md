# Reka Open-Source Strategy

Complete guide for launching Reka as an open-source project.

---

## 1. Repository Structure Recommendations

### Current to Target Mapping

```
reka/                              # Rename from shared-ai-infra
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml         # NEW
│   │   ├── feature_request.yml    # NEW
│   │   └── config.yml             # NEW
│   ├── PULL_REQUEST_TEMPLATE.md   # NEW
│   ├── FUNDING.yml                # NEW
│   ├── CODEOWNERS                 # NEW
│   └── workflows/
│       ├── ci.yml                 # EXISTS - enhance
│       ├── release.yml            # NEW
│       ├── docker-publish.yml     # NEW
│       └── docs-deploy.yml        # NEW
├── packages/                      # RENAME: move rag-api, mcp-server, dashboard here
│   ├── api/                       # was: rag-api
│   ├── mcp-server/                # was: mcp-server
│   └── dashboard/                 # was: dashboard
├── docker/                        # KEEP
├── docs/
│   ├── assets/                    # Logo, demo GIF, screenshots
│   │   ├── reka-logo.svg
│   │   └── demo.gif
│   └── ...                        # Docusaurus/Starlight site later
├── scripts/                       # KEEP
├── .env.example                   # NEW - root-level example
├── CHANGELOG.md                   # NEW
├── CODE_OF_CONDUCT.md             # NEW
├── CONTRIBUTING.md                 # NEW (created above)
├── LICENSE                        # NEW (AGPL-3.0 text)
├── README.md                      # NEW (created above)
├── SECURITY.md                    # NEW
└── CLAUDE.md                      # KEEP (useful for contributors using Claude)
```

### Decision: Monorepo Restructure

**Recommendation: Keep flat structure for now, rename later.**

Moving to `packages/` is the right long-term play, but doing it at launch adds friction. The current `rag-api/`, `mcp-server/`, `dashboard/` structure is clear enough. Rename when you add a fourth package or need npm workspaces.

### Files to Add

#### CODE_OF_CONDUCT.md
Use the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). It's the industry standard. Just copy it.

#### SECURITY.md

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Email security@reka.dev with:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment

We will respond within 48 hours and provide a fix timeline within 7 days.

## Scope

- Reka API server
- MCP server
- Docker configurations
- Dependencies with known CVEs

## Out of Scope

- Ollama, Qdrant, Redis security (report to those projects directly)
- Self-hosting misconfigurations (running without auth on public internet)
```

#### LICENSE
Full AGPL-3.0 text (see License Strategy section below).

#### CHANGELOG.md
Use [Keep a Changelog](https://keepachangelog.com/) format. Generate retroactively from git history for v1.0.

---

## 2. GitHub Optimization

### Repository Description (160 chars)
```
Self-hosted RAG infrastructure for AI coding assistants. Memory governance, multi-project isolation, MCP native. Your code never leaves your machine.
```

### Topics/Tags (max 20)
```
rag
mcp
ai-coding
vector-database
memory
llm
self-hosted
typescript
qdrant
ollama
embeddings
developer-tools
claude-code
cursor
code-search
knowledge-base
retrieval-augmented-generation
mcp-server
ai-memory
open-source
```

### Pinned Issues for Launch

1. **"Roadmap: Reka v1.x"** -- public roadmap with checkboxes
2. **"Good First Issues: Start Here"** -- curated list linking to labeled issues
3. **"Show & Tell: Share Your Setup"** -- community showcase thread

### GitHub Discussions Categories

| Category | Purpose |
|----------|---------|
| **Announcements** | Releases, breaking changes, events |
| **Q&A** | Technical questions, troubleshooting |
| **Ideas** | Feature requests, architecture proposals |
| **Show and Tell** | Community setups, integrations, benchmarks |
| **General** | Everything else |

### Release Strategy

**Semantic versioning** with these conventions:

- `MAJOR` (2.0, 3.0): Breaking API/MCP tool changes, schema migrations required
- `MINOR` (1.1, 1.2): New features, new MCP tools, new providers
- `PATCH` (1.1.1): Bug fixes, performance improvements, docs

**Release process:**
1. Feature freeze on `main`
2. Create release branch `release/v1.x.x`
3. Generate changelog from conventional commits
4. Tag with `v1.x.x`
5. GitHub Actions builds and publishes Docker images + npm packages
6. GitHub Release with changelog

**Pre-releases:**
- `v1.2.0-beta.1` for testing new features
- `v1.2.0-rc.1` for release candidates

### GitHub Actions to Add

#### release.yml

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org

      - name: Build all packages
        run: |
          cd rag-api && npm ci && npm run build
          cd ../mcp-server && npm ci && npm run build

      - name: Publish MCP server to npm
        run: cd mcp-server && npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

#### docker-publish.yml

```yaml
name: Docker Publish
on:
  push:
    tags: ['v*']

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    strategy:
      matrix:
        package: [rag-api, dashboard]
    steps:
      - uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ./${{ matrix.package }}
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/${{ matrix.package }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}/${{ matrix.package }}:latest
```

#### Enhanced ci.yml additions

```yaml
# Add to existing ci.yml:
- name: Type check MCP server
  run: cd mcp-server && npm ci && npm run build

- name: Lint
  run: cd rag-api && npm run lint

- name: Dashboard build check
  run: cd dashboard && npm ci && npm run build
```

---

## 3. License Strategy

### Recommendation: AGPL-3.0

**AGPL-3.0 is the right choice for Reka.** Here's the comparison:

| Factor | AGPL-3.0 | BSL 1.1 | Apache 2.0 |
|--------|----------|---------|------------|
| **Truly open source** | Yes (OSI-approved) | No (time-delayed) | Yes |
| **Protects against cloud hosting** | Yes (network use = distribution) | Yes (usage grant excludes production) | No |
| **Community trust** | High (Qdrant, Grafana, Minio) | Medium (MariaDB, CockroachDB, Sentry) | Highest |
| **Enterprise adoption friction** | Medium (legal review needed) | Medium (complex terms) | Low |
| **Contributor attraction** | Good | Lower (not real OSS) | Best |
| **Commercial dual-license viable** | Yes (standard model) | Yes | Harder (no copyleft leverage) |
| **Precedent in infra tooling** | Grafana, Minio, MongoDB, Qdrant | Sentry, CockroachDB, MariaDB | Kubernetes, many others |

### Why AGPL over Apache

Apache-2.0 would let any cloud provider host Reka as a service without contributing back. For an infrastructure product, AGPL-3.0 provides the right balance: fully open for self-hosting (which is Reka's primary use case), but requires network service providers to share modifications.

### Why AGPL over BSL

BSL is not recognized as open source by the OSI. This matters for community trust and adoption. "Open source" has a specific meaning, and using BSL while calling the project "open source" invites justified criticism. AGPL achieves the same protection goals while being genuinely open source.

### Commercial/Enterprise Licensing

**Dual-license model** (used by MongoDB, Qt, MySQL):

1. **AGPL-3.0** -- free for everyone, copyleft applies
2. **Reka Enterprise License** -- commercial license for organizations that:
   - Cannot comply with AGPL (can't share modifications)
   - Want to embed Reka in proprietary products
   - Need SLAs, support, and enterprise features

**Enterprise-only features** (things that only matter at scale):
- SSO/SAML authentication
- Multi-tenant management UI
- Priority support and SLAs
- Custom embedding model hosting
- Audit logging
- Advanced analytics dashboard

**Pricing model:** Per-organization, not per-seat. Self-hosted = no usage tracking.

### CLA (Contributor License Agreement)

**Recommendation: Use a CLA.** Required for dual-licensing.

Use the **Apache Individual CLA** (standard, well-understood) or a lightweight DCO (Developer Certificate of Origin) enforced via `Signed-off-by` lines.

For dual-licensing, a CLA is necessary because:
- Contributors must grant you the right to offer their code under the commercial license
- Without a CLA, every contributor's code is AGPL-only, and you cannot dual-license

**Implementation:** Use [CLA Assistant](https://cla-assistant.io/) -- free, GitHub-integrated, sign-once.

---

## 4. .github/ Templates

### .github/ISSUE_TEMPLATE/bug_report.yml

```yaml
name: Bug Report
description: Report a bug in Reka
labels: ["bug", "needs-triage"]
body:
  - type: markdown
    attributes:
      value: |
        Thank you for reporting a bug. Please fill out the sections below.

  - type: textarea
    id: description
    attributes:
      label: Bug Description
      description: A clear description of the bug.
    validations:
      required: true

  - type: textarea
    id: reproduce
    attributes:
      label: Steps to Reproduce
      description: How to trigger this bug.
      value: |
        1.
        2.
        3.
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected Behavior
      description: What you expected to happen.
    validations:
      required: true

  - type: textarea
    id: actual
    attributes:
      label: Actual Behavior
      description: What actually happened. Include error messages and logs.
    validations:
      required: true

  - type: dropdown
    id: component
    attributes:
      label: Component
      options:
        - API Server (rag-api)
        - MCP Server
        - Dashboard
        - Docker / Infrastructure
        - Memory System
        - Search / Indexing
        - Other
    validations:
      required: true

  - type: input
    id: version
    attributes:
      label: Reka Version
      placeholder: "v1.2.0"

  - type: textarea
    id: environment
    attributes:
      label: Environment
      description: OS, Docker version, Node.js version, GPU info if relevant.
      placeholder: |
        - OS: Ubuntu 22.04
        - Docker: 24.0.7
        - Node.js: 20.11.0
```

### .github/ISSUE_TEMPLATE/feature_request.yml

```yaml
name: Feature Request
description: Suggest a new feature for Reka
labels: ["enhancement", "needs-triage"]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What problem does this solve? What are you trying to do?
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
      description: How would you like this to work?
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: Other approaches you've thought about.

  - type: dropdown
    id: component
    attributes:
      label: Component
      options:
        - API Server (rag-api)
        - MCP Server / Tools
        - Dashboard
        - Memory System
        - Search / Indexing
        - New Integration
        - Documentation
        - Other
    validations:
      required: true
```

### .github/ISSUE_TEMPLATE/config.yml

```yaml
blank_issues_enabled: true
contact_links:
  - name: Question / Help
    url: https://github.com/AKE-REKA/reka/discussions/categories/q-a
    about: Ask questions in GitHub Discussions
  - name: Feature Discussion
    url: https://github.com/AKE-REKA/reka/discussions/categories/ideas
    about: Discuss feature ideas before opening a request
  - name: Discord
    url: https://discord.gg/reka
    about: Real-time help and community chat
```

### .github/PULL_REQUEST_TEMPLATE.md

```markdown
## What

<!-- Brief description of what this PR does -->

## Why

<!-- Why is this change needed? Link to issue if applicable -->

Closes #

## How

<!-- How does this work? Key implementation details -->

## Testing

<!-- How was this tested? -->

- [ ] Unit tests added/updated
- [ ] Manual testing done
- [ ] Existing tests pass (`npm test`)

## Checklist

- [ ] Code follows project style guidelines
- [ ] TypeScript compiles without errors
- [ ] Self-review completed
- [ ] Documentation updated (if applicable)
- [ ] No breaking changes (or documented in description)
```

### .github/CODEOWNERS

```
# Default owners for everything
* @ake

# Specific areas
/rag-api/src/services/memory*.ts @ake
/rag-api/src/services/consolidation*.ts @ake
/mcp-server/ @ake
/dashboard/ @ake
/docker/ @ake
```

### .github/FUNDING.yml

```yaml
github: AKE-REKA
# custom: ["https://reka.dev/sponsor"]
```

---

## 5. Documentation Site Plan

### Recommendation: Starlight (Astro)

**Why Starlight over Docusaurus or Mintlify:**

| | Starlight | Docusaurus | Mintlify |
|---|---|---|---|
| Build speed | Fast (Astro) | Slower (React) | N/A (hosted) |
| Markdown-native | Yes | Yes | Yes |
| Self-hosted | Yes | Yes | No (SaaS) |
| Search built-in | Yes (Pagefind) | Yes (Algolia) | Yes |
| TypeScript API docs | Manual | Manual | Auto |
| Cost | Free | Free | $150/mo+ |
| Maintenance | Low | Medium | None |

### Page Hierarchy

```
docs/
├── index.md                    # Landing / overview
├── getting-started/
│   ├── index.md                # Quick start (mirrors README)
│   ├── installation.md         # Detailed install (Docker, manual, ARM64)
│   ├── first-project.md        # Walk through setting up first project
│   └── mcp-setup.md            # Connect to Claude Code, Cursor, Windsurf
├── concepts/
│   ├── architecture.md         # System architecture deep dive
│   ├── project-isolation.md    # How multi-project works
│   ├── memory-system.md        # Memory governance, consolidation, LTM
│   ├── search-pipeline.md      # How search works (embed → retrieve → rerank)
│   ├── code-graph.md           # Graph store, symbol index
│   └── smart-dispatch.md       # LLM-routed parallel lookups
├── guides/
│   ├── indexing.md             # How to index codebases
│   ├── memory.md               # Working with memories, ADRs, patterns
│   ├── agents.md               # Autonomous agent system
│   ├── confluence.md           # Confluence integration
│   ├── monitoring.md           # Prometheus, Grafana, Jaeger setup
│   ├── production.md           # Production deployment guide
│   └── troubleshooting.md      # Common issues and fixes
├── reference/
│   ├── api.md                  # REST API reference (all endpoints)
│   ├── mcp-tools.md            # MCP tool reference (all ~35 tools)
│   ├── configuration.md        # All env vars, all options
│   └── cli.md                  # CLI commands and scripts
├── contributing/
│   ├── index.md                # Links to CONTRIBUTING.md
│   ├── architecture.md         # Codebase walkthrough for contributors
│   └── adding-a-parser.md      # Tutorial: add a new file parser
└── changelog.md                # Release history
```

### Essential Pages for Launch (MVP)

These 8 pages are the minimum for a credible open-source launch:

1. **index.md** -- Landing page with value prop
2. **getting-started/index.md** -- Quick start (can be README content)
3. **getting-started/installation.md** -- Detailed install
4. **getting-started/mcp-setup.md** -- Connect to your IDE
5. **concepts/architecture.md** -- System overview
6. **reference/configuration.md** -- All env vars
7. **reference/mcp-tools.md** -- Tool reference
8. **reference/api.md** -- REST API endpoints

### API Reference Generation

Two approaches:

1. **Manual-first** (recommended for launch): Write the API reference by hand from route files. It's ~12 endpoints -- manageable and higher quality than auto-generated.

2. **Auto-generated** (add later): Add OpenAPI/Swagger annotations to Express routes using `swagger-jsdoc`, generate spec, render with Redoc or Scalar.

For MCP tools, extract from the tool definitions in `mcp-server/src/tools/*.ts` -- they already have descriptions and schemas.

---

## 6. Pre-Launch Checklist

### Repository Hygiene

- [ ] Remove hardcoded paths (`/home/ake/...`) from all files
- [ ] Remove project-specific references (`cypro`, `crowley`)
- [ ] Rename npm packages (`@shared/rag-api` -> `@reka/api`, `@crowley/rag-mcp` -> `@reka/mcp-server`)
- [ ] Add `.env.example` files with all variables documented
- [ ] Ensure no secrets in git history (rotate any that were committed)
- [ ] Remove Ukrainian-language content from user-facing docs (keep in internal docs if preferred)
- [ ] Add LICENSE file with full AGPL-3.0 text
- [ ] Create logo (SVG, at minimum a text-based placeholder)
- [ ] Record demo GIF (5-10 seconds, showing index + search + recall)

### Code Readiness

- [ ] All tests pass
- [ ] No TypeScript errors
- [ ] ESLint clean
- [ ] Docker images build successfully
- [ ] Fresh clone + docker compose up + first project works end-to-end
- [ ] Document minimum hardware requirements

### GitHub Setup

- [ ] Create GitHub organization (e.g., `reka-ai` or `reka-dev`)
- [ ] Transfer/create repo under org
- [ ] Set repository description and topics
- [ ] Enable Discussions
- [ ] Create issue labels (see Contributing section)
- [ ] Create 5-10 good first issues
- [ ] Set up branch protection on `main`
- [ ] Enable GitHub Sponsors (optional)
- [ ] Set up CLA Assistant

### Launch Day

- [ ] Publish to Hacker News (Show HN)
- [ ] Post on r/LocalLLaMA, r/selfhosted, r/programming
- [ ] Tweet/post thread explaining the problem and solution
- [ ] Submit to Product Hunt (optional, dev tools category)
- [ ] Post in MCP-related Discord servers and communities
- [ ] Publish npm package (`@reka/mcp-server`)
- [ ] Push Docker images to GHCR

---

## 7. Growth Strategy

### Phase 1: Launch (Week 1)

- Ship README, CONTRIBUTING, LICENSE, basic docs
- 5-10 good first issues ready
- Hacker News Show HN post
- Reddit posts (r/selfhosted, r/LocalLLaMA)

### Phase 2: Community (Month 1)

- Respond to all issues within 24h
- Merge first community PRs
- Publish "How Reka's Memory System Works" blog post
- Add more parsers (community-driven)
- Weekly Discord office hours

### Phase 3: Ecosystem (Month 2-3)

- Plugin system for custom tools
- Helm chart for Kubernetes deployment
- One-click deploy buttons (Railway, Coolify)
- Integration guides for popular frameworks
- Benchmarks vs alternatives

### Phase 4: Sustainability (Month 3-6)

- Enterprise license tier
- Hosted docs site
- Conference talks / meetup presentations
- GitHub Sponsors / Open Collective
- Consider Y Combinator if traction warrants
