# Reka — Go-to-Market Plan

## Self-Hosted RAG Infrastructure for AI Coding Assistants

---

## 1. Pre-Launch Checklist

### MUST DO Before Public Launch (Priority Order)

| # | Task | Effort | Depends On | Why It Blocks Launch |
|---|------|--------|------------|---------------------|
| 1 | **One-command install script** (`curl -fsSL https://reka.dev/install.sh \| bash`) | 3 days | — | Nobody will try a product that takes 30 min to set up |
| 2 | **docker-compose.yml hardening** — health checks, restart policies, volume persistence, `.env.example` with sane defaults | 2 days | — | Current compose file is dev-grade, not production-grade |
| 3 | **README rewrite** — hero section, 30-second pitch, animated GIF/asciicast of setup + first query, architecture diagram | 2 days | #1 | README is your landing page on GitHub |
| 4 | **Getting Started guide** (docs/getting-started.md) — install, configure first project, index codebase, first search, first memory | 3 days | #1, #2 | First-run experience determines retention |
| 5 | **Memory governance demo** — a scripted walkthrough showing quarantine → review → promote flow with real examples | 1 day | — | This is your differentiator; must be visible in 60 seconds |
| 6 | **CI pipeline** — GitHub Actions: lint, build, test (the 54 existing tests), Docker image build | 2 days | — | No badges = no credibility for infra projects |
| 7 | **License decision** — recommend AGPL-3.0 (protects self-hosted value, allows SaaS tier later without license change) or BSL 1.1 | 0.5 days | — | No license = no adoption by any company |
| 8 | **Security audit pass** — no hardcoded secrets, no default passwords, API key auth on all endpoints, rate limiting | 2 days | — | Self-hosted infra with no auth is a liability |
| 9 | **Changelog & versioning** — CHANGELOG.md, semantic versioning, GitHub Releases with binaries | 1 day | #6 | Users need to know what changed between versions |
| 10 | **Landing page** (reka.dev or GitHub Pages) — one-pager with install command, features, architecture, comparison table | 3 days | #3 | Needed for HN/PH/Reddit links |

**Subtotal: 19.5 dev-days (~4 weeks at sustainable pace)**

### CAN WAIT Until After Launch

| Task | Effort | When to Do It |
|------|--------|---------------|
| Web dashboard polish (Vue 3 app) | 5 days | Week 5-6, after initial feedback |
| OpenAI-compatible API endpoint | 3 days | When users request it |
| Helm chart / Kubernetes deployment | 4 days | When first enterprise inquiry arrives |
| Plugin system for custom parsers | 3 days | Month 2 |
| Telemetry (opt-in, anonymous usage stats) | 2 days | Month 2 |
| Multi-user auth / RBAC | 5 days | Pro/Enterprise tier development |
| Hosted SaaS infrastructure | 15 days | Month 4-6, only if traction justifies it |
| VS Code extension | 8 days | Month 3, if community doesn't build one first |

### Dependency Graph

```
License (#7) ─────────────────────────────────┐
                                               ▼
Install Script (#1) ──► Getting Started (#4) ──► README (#3) ──► Landing Page (#10)
                                               ▲
Docker Hardening (#2) ────────────────────────┘

CI Pipeline (#6) ──► Changelog (#9)
Security Audit (#8) ──► Install Script (#1)
Memory Demo (#5) ──► README (#3)
```

---

## 2. Launch Strategy — 8-Week Timeline

Assumes start date: **Monday, Week 1 = April 6, 2026**

### Week 1-2: Preparation (April 6-19)

**Week 1 — Foundation**
| Day | Action |
|-----|--------|
| Mon | License decision (AGPL-3.0). Create CHANGELOG.md. Set up GitHub project board |
| Tue | Security audit pass — add API key auth, remove defaults, add rate limiting |
| Wed | Docker-compose hardening — health checks, .env.example, volume config |
| Thu | Install script v1 — test on Ubuntu 22.04, 24.04, macOS (ARM + Intel) |
| Fri | CI pipeline — GitHub Actions for lint, build, test, Docker image push to GHCR |

**Week 2 — Content**
| Day | Action |
|-----|--------|
| Mon | README rewrite — hero section, badges, architecture diagram |
| Tue | Getting Started guide — end-to-end walkthrough |
| Wed | Memory governance demo — record asciicast, create GIF for README |
| Thu | Landing page — deploy to GitHub Pages (reka.dev if domain acquired) |
| Fri | Write HN launch post draft. Set up Discord server. Internal dogfood test |

**Deliverables by end of Week 2:**
- GitHub repo is public-ready with polished README
- One-command install works on Linux + macOS
- Landing page is live
- Discord server exists with channel structure
- CI is green with badges

### Week 3-4: Soft Launch (April 20 — May 3)

**Week 3 — Seed Users**
| Day | Action |
|-----|--------|
| Mon | Post in r/SelfHosted — "I built a self-hosted RAG server for AI coding assistants" |
| Tue | Post in r/LocalLLaMA — focus on Ollama integration, local-only angle |
| Wed | Share in 3-5 relevant Discord servers (MCP community, Ollama, self-hosted) |
| Thu | Publish Dev.to article: "Why Your AI Coding Assistant Forgets Everything" |
| Fri | Collect feedback from first 10-20 users. Fix top 3 pain points |

**Week 4 — Iterate**
| Day | Action |
|-----|--------|
| Mon-Tue | Fix bugs and UX issues reported by early users |
| Wed | Ship patch release (v1.2.1) with fixes. Update CHANGELOG |
| Thu | Write 2-3 GitHub Discussions posts seeding the community |
| Fri | Prep Product Hunt assets (logo, tagline, screenshots, maker comment) |

**Deliverables by end of Week 4:**
- 50-100 GitHub stars
- 20-40 actual installs (measured by Discord joins + GitHub issues)
- Top bugs fixed
- Product Hunt submission ready

### Week 5-6: Public Launch (May 4-17)

**Week 5 — Launch Week**
| Day | Action |
|-----|--------|
| Mon | Pre-schedule tweets/posts. Email early users asking for PH upvotes |
| **Tue** | **Product Hunt launch** (Tuesday = highest traffic day). Post maker comment immediately. Respond to every comment within 30 min |
| Wed | **Hacker News** — "Show HN: Reka – Self-hosted RAG infrastructure for AI coding assistants". Post at 8 AM ET. Stay in comments all day |
| Thu | Post in r/programming with technical deep-dive angle |
| Fri | LinkedIn post targeting engineering managers. Cross-post highlights |

**Week 6 — Amplify**
| Day | Action |
|-----|--------|
| Mon | Publish blog post: "How Memory Governance Prevents AI from Learning Bad Patterns" |
| Tue | Record and publish YouTube demo (10-min setup + usage walkthrough) |
| Wed | Engage with every GitHub issue, star, fork. Personal thank-you to contributors |
| Thu | Post comparison article: "Reka vs Cursor vs Augment vs Continue.dev" |
| Fri | Week in review — metrics check, plan adjustments |

**Deliverables by end of Week 6:**
- 300-800 GitHub stars (depends on HN traction)
- 100-200 installs
- First external contributions (issues, PRs, docs)

### Week 7-8: Post-Launch Momentum (May 18-31)

**Week 7**
| Day | Action |
|-----|--------|
| Mon | Ship v1.3.0 with top-requested features from launch feedback |
| Tue | Publish "Building Reka" technical blog post (architecture deep-dive) |
| Wed | Start weekly "Office Hours" in Discord (30 min, async Q&A if live is hard) |
| Thu | Reach out to 5 dev tool YouTubers/bloggers for coverage |
| Fri | Identify and personally onboard 3 "power users" as potential ambassadors |

**Week 8**
| Day | Action |
|-----|--------|
| Mon | Launch GitHub Sponsors page. Add sponsor button to repo |
| Tue | Publish roadmap as GitHub Discussion — let community vote on features |
| Wed | Begin Pro tier development based on launch learnings |
| Thu | Write "Month 1 Retrospective" blog post with real metrics |
| Fri | Set Q2 goals based on traction data |

---

## 3. Channel Strategy

### Channel Breakdown

| Channel | What to Post | When | Expected Reach | Effort |
|---------|-------------|------|----------------|--------|
| **GitHub** | Polished repo, Releases, Discussions | Ongoing | Primary discovery channel | High (ongoing) |
| **Hacker News** | Show HN post, technical comments | Week 5 Wed, 8 AM ET | 5K-50K views (wide variance) | 1 day prep + 1 day comments |
| **Product Hunt** | Launch page with screenshots, video | Week 5 Tue, 12:01 AM PT | 1K-5K visits | 2 days prep + 1 day engagement |
| **Reddit r/SelfHosted** | "I built X" post, focus on docker-compose simplicity | Week 3 Mon | 10K-30K views | 2 hours |
| **Reddit r/LocalLLaMA** | Ollama integration angle, privacy-first | Week 3 Tue | 15K-40K views | 2 hours |
| **Reddit r/programming** | Technical deep-dive, architecture focus | Week 5 Thu | 5K-20K views | 3 hours |
| **Dev.to** | Tutorial-style articles (2-3 during launch) | Week 3 Thu, Week 6 Mon | 2K-8K reads each | 4 hours each |
| **Twitter/X** | Thread: "I built X in 6 months, here's what I learned" + daily tips | Week 5 onward, 2-3x/week | 500-5K impressions/post | 30 min/post |
| **Discord** | Community hub, support, announcements | Ongoing from Week 2 | 50-200 members Month 1 | 30 min/day |
| **YouTube** | 10-min demo, setup walkthrough | Week 6 Tue | 500-3K views | 1 day |
| **LinkedIn** | Engineering manager angle, team productivity | Week 5 Fri, then weekly | 1K-5K impressions | 1 hour/post |

### 30-Day Content Calendar (Starting from Public Launch, Week 5)

| Day | Channel | Content |
|-----|---------|---------|
| Day 1 (Tue) | Product Hunt | Launch: "Reka — Self-hosted RAG that gives your AI coding assistant persistent memory" |
| Day 1 (Tue) | Twitter/X | Thread: "Today I'm launching Reka. Here's why AI coding assistants need memory governance" |
| Day 2 (Wed) | Hacker News | "Show HN: Reka – Self-hosted RAG infra for AI coding assistants with memory governance" |
| Day 3 (Thu) | Reddit r/programming | "How I built a memory layer that prevents AI from learning bad coding patterns" |
| Day 4 (Fri) | LinkedIn | "Why engineering teams need memory governance for AI coding assistants" |
| Day 5-6 | — | Respond to comments, fix bugs, engage |
| Day 7 (Mon) | Dev.to + Blog | "How Memory Governance Prevents AI from Learning Bad Patterns" |
| Day 8 (Tue) | YouTube | 10-minute demo video: Setup to first query |
| Day 10 (Thu) | Dev.to | "Reka vs Cursor vs Augment: A Detailed Comparison" |
| Day 12 (Sat) | Twitter/X | "Week 1 launch numbers" transparency thread |
| Day 14 (Mon) | Blog | "The Architecture of Reka: Human-Memory-Inspired RAG" |
| Day 16 (Wed) | Reddit r/SelfHosted | Update post: "Reka v1.3.0 — here's what changed based on your feedback" |
| Day 18 (Fri) | Twitter/X | Technical tip thread: "5 things I learned building a multi-tenant vector store" |
| Day 21 (Mon) | Dev.to | "Building an MCP Server with 35 Tools: Lessons Learned" |
| Day 23 (Wed) | Discord | First "Office Hours" session |
| Day 25 (Fri) | LinkedIn | "Month 1 of Reka: What worked, what didn't" |
| Day 28 (Mon) | Blog | "Month 1 Retrospective" with real metrics |
| Day 30 (Wed) | GitHub | Public roadmap discussion + community feature vote |

---

## 4. Pricing Strategy

### Tier Structure

#### Free / Open Source (Self-Hosted)
**Price: $0 forever**

| Included | Limits |
|----------|--------|
| Full RAG API + MCP server | Unlimited projects |
| All 35 MCP tools | Unlimited queries |
| Memory governance (quarantine/promote) | Unlimited memory |
| Multi-project isolation (12 collections) | — |
| Ollama + BGE-M3 (fully local) | — |
| Docker Compose deployment | — |
| Community support (Discord + GitHub) | — |
| All current features as of each release | — |

**Rationale:** The free tier is the entire product. This is critical — self-hosted users are your marketing engine. Never cripple the free tier.

#### Pro (Self-Hosted + Premium Features)
**Price: $12/month or $120/year (per developer seat)**

| Feature | Why It's Pro |
|---------|-------------|
| Web dashboard with analytics | Visual layer, not core functionality |
| Team memory sharing (multi-user RBAC) | Requires auth infrastructure |
| Scheduled memory consolidation agents | Compute-intensive automation |
| Priority email support (48h SLA) | Your time has value |
| Claude/OpenAI provider integration (managed API keys) | Convenience feature |
| Custom memory retention policies | Advanced governance |
| Backup/restore CLI tools | Data safety premium |
| Early access to new features (2-week head start) | Exclusivity |

**Justification for $12/mo:** Cursor charges $20-40/mo for a closed-source editor. Reka Pro at $12/mo is the "boring infrastructure" pricing — cheaper than a lunch, saves hours/week.

#### Enterprise (Self-Hosted + Support)
**Price: $49/developer/month (minimum 10 seats = $490/mo), annual contract**

| Feature | Details |
|---------|---------|
| Everything in Pro | — |
| SSO / SAML integration | Required for enterprise procurement |
| Audit logging | Compliance requirement |
| Helm chart + Kubernetes deployment | Enterprise infra standard |
| Dedicated Slack/Teams support channel | Direct access to maintainer |
| SLA: 24h response, 4h for critical | Contractual commitment |
| Custom integrations (2 per quarter) | White-glove service |
| On-call architecture review (1h/month) | Consulting value-add |

### Competitor Comparison

| Feature | Reka Free | Reka Pro | Cursor Pro | Augment | Continue.dev | Greptile |
|---------|-----------|----------|------------|---------|-------------|----------|
| Price/mo | $0 | $12 | $20 | $30 | $0 | $30 |
| Self-hosted | Yes | Yes | No | No | Partial | No |
| Data stays local | Yes | Yes | No | No | Partial | No |
| Memory governance | Yes | Yes | No | No | No | No |
| Multi-project | Yes | Yes | No | Yes | Yes | Yes |
| MCP native | Yes | Yes | No | No | Yes | No |
| Custom LLM | Yes | Yes | No | No | Yes | No |
| Team features | No | Yes | Yes | Yes | No | Yes |

### Year 1 Revenue Projections

**Conservative (2% conversion, 500 free users):**
| Quarter | Free Users | Pro Users | Enterprise | MRR |
|---------|-----------|-----------|------------|-----|
| Q1 (launch) | 100 | 0 | 0 | $0 |
| Q2 | 250 | 5 | 0 | $60 |
| Q3 | 400 | 10 | 0 | $120 |
| Q4 | 500 | 15 | 0 | $180 |
| **Year 1 Total** | — | — | — | **$1,080** |

**Optimistic (5% conversion, 2,000 free users, 1 enterprise):**
| Quarter | Free Users | Pro Users | Enterprise | MRR |
|---------|-----------|-----------|------------|-----|
| Q1 (launch) | 300 | 0 | 0 | $0 |
| Q2 | 800 | 15 | 0 | $180 |
| Q3 | 1,400 | 40 | 1 (10 seats) | $970 |
| Q4 | 2,000 | 80 | 1 (15 seats) | $1,695 |
| **Year 1 Total** | — | — | — | **$9,735** |

**Reality check:** Year 1 revenue for a solo-dev OSS project is almost certainly not enough to live on. The goal of Year 1 is traction and community, not revenue. GitHub Sponsors may actually generate more than Pro subscriptions in the early months.

---

## 5. Community Building Plan

### Discord Server Structure

```
REKA
├── #welcome-rules          (read-only, rules + getting started link)
├── #announcements           (read-only, releases + blog posts)
├── SUPPORT
│   ├── #installation-help   (setup issues, docker, OS-specific)
│   ├── #configuration       (env vars, LLM providers, embeddings)
│   └── #bug-reports         (before filing GitHub issues)
├── DISCUSSION
│   ├── #general             (anything goes)
│   ├── #feature-requests    (ideas + community voting)
│   ├── #show-your-setup     (screenshots, configs, use cases)
│   └── #memory-governance   (dedicated channel for the key differentiator)
├── DEVELOPMENT
│   ├── #contributing        (PR discussion, dev setup)
│   ├── #architecture        (design discussions)
│   └── #integrations        (MCP, VS Code, other tools)
└── META
    └── #office-hours        (weekly async Q&A)
```

### First 100 Users Acquisition Tactics

| Tactic | Target | Expected Yield | Timeline |
|--------|--------|----------------|----------|
| r/SelfHosted post | Self-hosters who run Ollama | 15-30 users | Week 3 |
| r/LocalLLaMA post | Local LLM enthusiasts | 10-25 users | Week 3 |
| MCP Discord community | Claude Code/MCP users | 5-15 users | Week 3-4 |
| Ollama Discord | Ollama users wanting RAG | 5-10 users | Week 3-4 |
| Dev.to article | Developers searching for RAG | 5-15 users | Week 3-4 |
| HN Show HN | Technical developers | 20-50 users | Week 5 |
| Product Hunt | Early adopters | 10-30 users | Week 5 |
| Personal network | Developer contacts | 5-10 users | Week 1-4 |

**Total expected: 75-185 users in first 6 weeks**

### Early Adopter / Ambassador Program

**"Reka Pioneers" — First 50 users who actively use the product**

Benefits:
- `@Pioneer` role in Discord (permanent)
- Name in CONTRIBUTORS.md and website
- Direct access to maintainer for feature requests
- Free Pro tier for life when it launches
- Input on roadmap priorities

Requirements:
- Install and use Reka for at least 1 project
- File at least 1 bug report or feature request
- Optional: write about their experience (blog, tweet, etc.)

---

## 6. Content Marketing Plan

### 10 Blog Post Ideas

| # | Title | SEO Target | When |
|---|-------|------------|------|
| 1 | "Why Your AI Coding Assistant Forgets Everything (And How to Fix It)" | "AI coding assistant memory" | Week 3 |
| 2 | "Memory Governance: Preventing AI from Learning Your Team's Bad Patterns" | "AI memory governance" | Week 6 |
| 3 | "Self-Hosted AI Infrastructure: A Complete Guide for 2026" | "self-hosted AI infrastructure" | Week 7 |
| 4 | "Building a Multi-Tenant Vector Store with Qdrant" | "multi-tenant vector store qdrant" | Week 8 |
| 5 | "MCP Servers: Building 35 Tools for Claude Code" | "MCP server tutorial" | Month 2 |
| 6 | "Reka vs Cursor vs Augment: Which AI Coding Tool Deserves Your Data?" | "cursor vs augment comparison" | Week 6 |
| 7 | "Human-Memory-Inspired Architecture for RAG Systems" | "human memory RAG architecture" | Month 2 |
| 8 | "Zero to RAG in 5 Minutes: Self-Hosted Setup Guide" | "self-hosted RAG setup" | Week 4 |
| 9 | "How I Built an Open-Source Developer Tool as a Solo Dev" | "indie dev tool launch" | Month 2 |
| 10 | "The Hidden Cost of Cloud AI: Why Self-Hosted RAG Saves More Than Money" | "self-hosted vs cloud AI" | Month 3 |

### 5 Video Content Ideas

| # | Title | Length | Platform |
|---|-------|--------|----------|
| 1 | "Reka in 5 Minutes: Install to First Query" | 5 min | YouTube |
| 2 | "Memory Governance Deep Dive" | 8 min | YouTube |
| 3 | "Full Project Setup: From Zero to AI-Assisted Coding" | 15 min | YouTube |
| 4 | "Reka Architecture Walkthrough" | 10 min | YouTube |
| 5 | "Building MCP Tools for Claude Code" | 20 min | YouTube |

### SEO Keywords to Target

**High-intent:** "self-hosted RAG server", "AI coding assistant memory", "MCP server for code", "local RAG infrastructure", "qdrant self-hosted", "ollama RAG setup"

**Medium competition:** "AI memory governance", "self-hosted AI infrastructure", "RAG for code", "cursor alternative self-hosted", "augment code alternative"

**Long-tail:** "how to give AI coding assistant persistent memory", "self-hosted alternative to cursor", "prevent AI from learning bad code patterns", "multi-project RAG isolation"

---

## 7. Metrics & KPIs

### Pre-Launch (Weeks 1-4)

| Metric | Target |
|--------|--------|
| Install script tested on N platforms | 3+ (Ubuntu, macOS ARM, macOS Intel) |
| Discord members | 20-50 |
| GitHub stars | 50-100 |
| Time-to-first-query (new user) | Under 10 minutes |

### At Launch (Weeks 5-6)

| Metric | Target |
|--------|--------|
| GitHub stars | 300-800 |
| Unique repo visitors | 2,000-10,000 |
| Repo clones | 200-500 |
| Discord members | 100-200 |
| HN post score | 50+ points |
| Product Hunt ranking | Top 10 of the day |
| Install success rate | 80%+ |

### Success Criteria by Phase

| Phase | Success | Acceptable | Needs Rethinking |
|-------|---------|------------|-----------------|
| **Pre-launch** (W1-4) | 100+ stars, 50+ Discord | 50+ stars, 20+ Discord | Under 30 stars |
| **Launch** (W5-6) | 500+ stars, HN front page | 200+ stars, Show HN top 5 | Under 100 stars |
| **Post-launch** (W7-8) | 800+ stars, 10+ contributors | 400+ stars, 5+ contributors | Flat growth |
| **Month 3** | 1,500+ stars, first Pro subscribers | 800+ stars, active Discord | Declining activity |
| **Month 6** | 3,000+ stars, $500+ MRR | 1,500+ stars, $100+ MRR | Under 1K stars |

### Solo Developer Priority Stack

1. **Product quality** (50% of time) — nothing else matters if install is broken
2. **GitHub presence** (20%) — README, issues, discussions, releases
3. **Content** (15%) — 1 blog post/week during launch, then 1-2/month
4. **Community** (10%) — Discord + GitHub Discussions, daily 30-min check-in
5. **Social media** (5%) — Twitter/X threads, LinkedIn posts when you have something to say

Do not try to be everywhere. Pick 2-3 channels that work and double down. For a self-hosted dev tool, the likely winners are **r/SelfHosted + Hacker News + GitHub organic discovery**.
