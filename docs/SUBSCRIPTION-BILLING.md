# Reka: Subscription & Billing System Design

## 1. Subscription Tiers

### Infrastructure Cost Baseline

| Resource | Provider | Unit Cost |
|---|---|---|
| Vector storage | Qdrant Cloud (1GB RAM) | ~$0.05/GB/month |
| Qdrant node (1 vCPU, 4GB) | Qdrant Cloud | ~$65/month |
| Embedding (BGE-M3, self-hosted) | Hetzner GPU (L4) | ~$0.30/hr shared |
| Embedding (OpenAI text-embedding-3-small) | OpenAI | $0.02/1M tokens |
| Claude Sonnet input | Anthropic | $3.00/1M tokens |
| Claude Sonnet output | Anthropic | $15.00/1M tokens |
| Claude Haiku input | Anthropic | $0.25/1M tokens |
| Claude Haiku output | Anthropic | $1.25/1M tokens |

### Tier Definitions

#### Free (Community Edition) — $0
- Fully self-hosted only
- All core RAG features (indexing, search, memory)
- MCP server for any IDE
- Local embeddings (BGE-M3 or Ollama)
- Local LLM routing (Ollama)
- Unlimited projects, unlimited storage (your hardware)
- Community GitHub Discussions support

#### Starter — $12/month ($10/month annual)
- 1 seat, 3 projects
- 500 MB cloud vector storage (~500K LoC)
- 500 LLM completions/month
- 10,000 search queries/month
- 50,000 embedding generations/month
- Basic dashboard
- Email support (48hr)
- 1 API key
- Cost to serve: ~$3.50/user/month → **71% margin**

#### Team — $24/developer/month ($20/developer/month annual)
- Min 2 seats, max 50
- 2 GB storage per project
- 2,000 LLM calls/month per seat
- 50,000 searches/month per seat
- Unlimited projects and indexed files
- Full dashboard + analytics
- Memory governance UI
- Team memory sharing
- Confluence integration
- Priority support (24hr)
- Pay-as-you-go overages
- Cost to serve: ~$8.36/user/month → **65% margin**

#### Enterprise — Custom (from $35/developer/month, annual)
- Min 20 seats
- Unlimited everything (fair use)
- SSO/SAML, SCIM
- Audit logs, data residency (EU/US)
- 99.9% SLA
- SOC 2 Type II
- Dedicated support channel
- Custom integrations, on-premise option
- Cost to serve: ~$15.30/user/month → **56% margin**

## 2. Usage-Based Pricing

| Metric | Unit Cost (ours) | Sell Price | Markup | Metering Point |
|---|---|---|---|---|
| Vector storage | $0.055/GB/mo | $0.25/GB/mo | 4.5x | `vector-store.ts` collection_info |
| Embeddings | $0.003/1K | $0.01/1K | 3.3x | `embedding.ts` generateEmbedding() |
| LLM Haiku | $0.25/$1.25 per 1M tok | $0.50/$2.50 | 2x | `llm.ts` complete() usage |
| LLM Sonnet | $3/$15 per 1M tok | $6/$25 | 2x | `llm.ts` complete() usage |
| Search queries | $0.0003/query | $0.001/query | 3.3x | `routes/search.ts` handler |
| Memory ops | $0.005/op | $0.01/op | 2x | `memory.ts` remember()/recall() |

## 3. Billing Implementation (Stripe)

### Products
- `reka_starter` → $12/mo flat + metered overages
- `reka_team` → $24/seat/mo + metered overages
- `reka_enterprise` → Custom

### API Endpoints
```
POST /api/billing/subscribe    — Create subscription
GET  /api/billing/usage        — Current usage + limits
GET  /api/billing/invoices     — Invoice history
POST /api/billing/cancel       — Cancel (at period end by default)
POST /api/billing/upgrade      — Prorated upgrade
POST /api/billing/webhook      — Stripe webhooks
```

### Usage Collection
```
Edge (MCP) → API request with Bearer key → Metering middleware (async, non-blocking) → Redis INCR → Hourly flush to Postgres → Daily report to Stripe
```

### Trial
- 14 days, no credit card required
- Full Team tier features, 1 project limit
- Target conversion: 15-20%

### Cancellation
- Default: at period end (keeps access)
- Data preserved 30 days → export available → then deleted
- Reactivation within 30 days restores data

## 4. API Key System

### Format
```
rk_live_<tier>_<32 hex chars>
rk_test_<tier>_<32 hex chars>
```
- Prefix `rk_` — identifiable in scanners
- Only SHA-256 hash stored in DB
- Full key shown once at creation

### Key Types
| Type | Scope | Limit |
|---|---|---|
| Personal | User, all projects | 1/user |
| Team Service | Org-wide, no user identity | 2/org |
| Team Member | User within org | 1/member |
| CI/CD | Specific projects, write-only indexing | 5/org |

### Rate Limits
| Tier | Req/min | Burst (10s) |
|---|---|---|
| Starter | 60 | 20 |
| Team | 120 | 40 |
| Enterprise | 600 | 200 |

### Subscription Lapse
| Phase | Duration | Behavior |
|---|---|---|
| Active | Current | Full access |
| Past due | 0-7 days | Full access + warning |
| Grace | 7-14 days | Read-only |
| Suspended | 14-30 days | No access, data preserved |
| Terminated | 30+ days | Data deleted |

## 5. Feature Gating

### Three-Layer Enforcement
1. **Auth middleware** — validate key, load org context from Redis (5min TTL)
2. **Route middleware** — `requireFeature('dashboard_analytics')`, `checkQuota('llm_calls')`
3. **Service layer** — per-project storage checks, nuanced limits

### Graceful Degradation
| Limit reached | Behavior |
|---|---|
| Storage | New indexing blocked, search works |
| LLM calls | Falls back to local Ollama if configured |
| Search queries | Rate reduced to 10/min |
| Memory ops | Queued on Edge, synced when quota resets |
| Subscription lapsed | Read-only mode, 402 with reactivation link |

## 6. Revenue Model

### Break-Even
- Fixed costs: ~$600/month (Qdrant cluster, GPU, servers, monitoring)
- Break-even: ~50 paying users (realistic mix)
- Achievable: 3-6 months post-launch

### Projections
| Month | Free | Starter | Team (seats) | Enterprise (seats) | MRR |
|---|---|---|---|---|---|
| 1 | 200 | 10 | 0 | 0 | $120 |
| 3 | 800 | 40 | 20 | 0 | $960 |
| 6 | 2,000 | 80 | 60 | 20 | $2,700 |
| 12 | 5,000 | 150 | 200 | 80 | $9,400 |
| 18 | 10,000 | 250 | 500 | 200 | $22,000 |

### LLM Cost Per User
| Pattern | Searches/day | Asks/day | Monthly LLM cost |
|---|---|---|---|
| Light (Starter) | 10 | 2 | $1.48 |
| Medium (Team) | 25 | 5 | $3.96 |
| Heavy (Enterprise) | 50 | 10 | $8.04 |

## 7. Competitive Positioning

| Feature | Reka Free | Reka Team | Cursor ($20) | Augment ($30) | Copilot ($19) |
|---|---|---|---|---|---|
| Code completion | No | No | Yes | Yes | Yes |
| Codebase search | Yes | Yes | Basic | Yes | Basic |
| Persistent memory | Yes | Yes | No | Partial | No |
| Self-hostable | Yes | Yes | No | No | No |
| Custom LLM | Yes | Yes | No | No | No |
| MCP native | Yes | Yes | No | No | No |
| Team sharing | No | Yes | No | Partial | No |

**Reka is infrastructure (like Supabase), not an IDE plugin (like Copilot). It complements existing tools.**

## 8. Pricing Page FAQ

**Is Reka a replacement for Copilot/Cursor?**
No. Reka is infrastructure that makes your existing AI tools smarter with persistent memory and codebase understanding. Use alongside any MCP-compatible tool.

**What happens to my data if I cancel?**
Preserved 30 days. Export as JSON anytime. After 30 days, permanently deleted. Community plan data never leaves your machine.

**Can I mix self-hosted and cloud?**
Yes. Reka Edge runs locally for indexing. Choose which cloud services to use (storage, LLM, dashboard).

**Is my code sent to the cloud?**
Only vector embeddings (numbers, not source code) go to Reka Cloud for storage. Cloud LLM features send relevant snippets to Anthropic under their privacy terms. Enterprise can deploy fully on-premise.

**Do you offer startup/OSS discounts?**
50% off Team for YC companies, OSS maintainers (500+ stars), and nonprofits. Contact oss@reka.dev.
