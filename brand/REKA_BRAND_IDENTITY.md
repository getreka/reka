# Reka Brand Identity

---

## 1. Brand Name Analysis

### Etymology and Meaning

**Reka** carries meaning across multiple language families, each reinforcing the product's identity:

| Language | Meaning | Connection to Product |
|----------|---------|----------------------|
| Czech, Slovak | "river" | Flow of knowledge through the system |
| Slovenian | "river" | Continuous data streams |
| Serbian, Croatian | "river" (река/reka) | Tributaries = multi-project isolation |
| Polish | "river" (rzeka, phonetically similar) | — |
| Hungarian | "river" (reka, archaic/poetic) | — |
| Swedish | evokes "räka" (shrimp) — no conflict; "reka" has no standard meaning | Clean namespace in Scandinavian |
| Finnish | no standard meaning; phonetically clean | Fits Nordic tech branding |
| Japanese | "reka" (レカ) — no common meaning | No conflict; easy katakana |
| Maori | "sweet" | Positive connotation |

**Primary narrative:** Reka is a river. Knowledge flows through it — indexed, filtered, governed, and delivered downstream to AI assistants. Rivers have tributaries (multi-project isolation), natural filtration (memory governance), and persistent flow (self-hosted, always running).

**Secondary narrative:** "Reka" derives from "recall" — the core action of retrieval-augmented generation. The Scandinavian phonetic feel signals reliability, minimalism, and engineering quality (cf. Vercel, Supabase, Linear).

### Domain Suggestions

| Domain | Status to Check | Priority |
|--------|----------------|----------|
| `reka.dev` | High value, likely taken — check availability | 1st choice |
| `getreka.dev` | Common fallback pattern | 2nd choice |
| `rekadev.com` | .com backup | 3rd choice |
| `reka.sh` | Shell-native feel, suits CLI tool | Strong alternative |
| `reka.run` | Action-oriented | Good for docs/playground |
| `usreka.com` | "use reka" | Fallback |
| `reka.tools` | Descriptive TLD | Viable |

### Trademark Conflicts to Investigate

- **Reka AI** (reka.ai) — AI research company (founded 2023, Singapore). Direct conflict in AI space. Monitor closely; different sub-domain (dev tools vs. foundational models) but brand confusion is possible.
- **Reka** — Various consumer brands in beauty/wellness. Low conflict risk for dev tools.
- **REKA** — Swiss appliance manufacturer. No conflict.
- **Recommendation:** File trademark in Nice Classification Class 9 (software) and Class 42 (SaaS/hosting). The strongest differentiator from Reka AI is the `.dev` TLD and "self-hosted infrastructure" positioning rather than "AI models."

---

## 2. Taglines

### Ranked Options

| Rank | Tagline | Use Case |
|------|---------|----------|
| **1** | **Memory your AI can trust.** | Primary. Hero section, README header, social bios. |
| **2** | **Self-hosted RAG infrastructure for AI that remembers.** | GitHub description. Descriptive, SEO-friendly. |
| **3** | **Your codebase, your memory, your infrastructure.** | Landing page. Emphasizes ownership/self-hosted. |
| **4** | **RAG infrastructure that filters the signal from the noise.** | Technical audiences. Speaks to memory governance. |
| **5** | **The river between your code and your AI.** | Brand storytelling. Plays on the name etymology. |
| **6** | **Recall with confidence.** | Compact. Social media, swag. |
| **7** | **Multi-project RAG. Zero vendor lock-in.** | Feature-focused. Comparison pages, ads. |
| **8** | **AI memory, governed.** | Shortest form. Badges, favicons, CLI banners. |
| **9** | **Bad patterns don't graduate.** | Memory quarantine feature. Blog posts, feature pages. |
| **10** | **Where AI knowledge goes to be vetted.** | Conversational. Community posts, talks. |

### Feature-Specific Taglines

| Feature | Tagline |
|---------|---------|
| Memory Governance | "Quarantine bad patterns. Promote good ones." |
| Self-Hosted | "Runs on your metal. Stays in your network." |
| Multi-Project | "One infrastructure. Every project isolated." |
| MCP Integration | "Plugs into any AI assistant via MCP." |
| Zero Lock-in | "Swap LLMs, embeddings, and vector stores. Keep your data." |

---

## 3. Visual Identity Guidelines

### Color Palette

#### Primary Colors

| Role | Light Theme | Dark Theme | Name |
|------|-------------|------------|------|
| **Primary** | `#1B65A7` | `#4A9FE5` | Reka Blue |
| **Primary Hover** | `#154F85` | `#6BB3EC` | Deep Current |
| **Primary Surface** | `#E8F1FA` | `#132840` | River Mist |

Reka Blue is a mid-saturation blue that evokes water/rivers without being generic "tech blue." It sits between cobalt and cerulean — authoritative but not corporate.

#### Secondary Colors

| Role | Light Theme | Dark Theme | Name |
|------|-------------|------------|------|
| **Secondary** | `#2D3748` | `#CBD5E0` | Granite |
| **Secondary Surface** | `#F7FAFC` | `#1A202C` | Slate Wash |

#### Accent Color

| Role | Light Theme | Dark Theme | Name |
|------|-------------|------------|------|
| **Accent** | `#38B2AC` | `#4FD1C5` | Tributary Teal |
| **Accent Hover** | `#2C9E98` | `#76E4D4` | — |
| **Accent Surface** | `#E6FFFA` | `#1A3A38` | — |

Teal as accent differentiates from the primary blue while staying in the water/flow metaphor. Used for interactive elements, links, and highlights.

#### Semantic Colors

| Role | Light Theme | Dark Theme | Usage |
|------|-------------|------------|-------|
| **Success** | `#38A169` | `#68D391` | Memory promoted, index complete |
| **Warning** | `#D69E2E` | `#F6E05E` | Memory quarantined, stale data |
| **Error** | `#E53E3E` | `#FC8181` | Failed operations, conflicts |
| **Info** | `#3182CE` | `#63B3ED` | Neutral notifications |

#### Neutral Scale

```
Gray 50:   #F7FAFC / Dark: #171923
Gray 100:  #EDF2F7 / Dark: #1A202C
Gray 200:  #E2E8F0 / Dark: #2D3748
Gray 300:  #CBD5E0 / Dark: #4A5568
Gray 400:  #A0AEC0 / Dark: #718096
Gray 500:  #718096 / Dark: #A0AEC0
Gray 600:  #4A5568 / Dark: #CBD5E0
Gray 700:  #2D3748 / Dark: #E2E8F0
Gray 800:  #1A202C / Dark: #EDF2F7
Gray 900:  #171923 / Dark: #F7FAFC
```

#### Background Colors

| Surface | Light Theme | Dark Theme |
|---------|-------------|------------|
| Page background | `#FFFFFF` | `#0F1117` |
| Card / Panel | `#F7FAFC` | `#161B22` |
| Elevated (modal, dropdown) | `#FFFFFF` | `#1C2333` |
| Code block | `#F1F5F9` | `#0D1117` |

### Typography

#### Font Stack

| Role | Font | Fallback | Weight Range |
|------|------|----------|-------------|
| **Headings** | [Inter](https://fonts.google.com/specimen/Inter) | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | 600 (semibold), 700 (bold) |
| **Body** | [Inter](https://fonts.google.com/specimen/Inter) | Same as above | 400 (regular), 500 (medium) |
| **Monospace** | [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) | `"Fira Code", "Cascadia Code", "Consolas", monospace` | 400, 500 |
| **Display (hero/marketing)** | [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) | `Inter, sans-serif` | 600, 700 |

**Why Inter:** Excellent readability at small sizes (UI, dashboards), complete OpenType features, huge language coverage, and it is the default for developer-facing products (Linear, Vercel, Supabase). Familiarity reduces cognitive friction.

**Why JetBrains Mono:** Ligature support for code, designed for IDE-scale reading, free and open source. Matches the developer audience.

**Why Instrument Sans for display:** Adds personality beyond Inter for marketing pages. Slightly geometric, modern, and distinctive without being decorative.

#### Type Scale

```
xs:    12px / 16px line-height
sm:    14px / 20px
base:  16px / 24px
lg:    18px / 28px
xl:    20px / 28px
2xl:   24px / 32px
3xl:   30px / 36px
4xl:   36px / 40px
hero:  48px / 52px  (Instrument Sans only)
```

### Logo Concept

**Primary mark:** A stylized lowercase "r" that incorporates a flowing river motif. The vertical stroke of the "r" is solid (representing infrastructure/stability), while the shoulder curves into a flowing line that splits into two parallel streams (representing multi-project isolation / tributaries). The streams terminate in a subtle right-pointing direction, implying forward flow.

**Construction notes for designer:**
- Geometric construction, not handwritten
- The split-stream element should work at 16x16 favicon size (simplifies to a single curve at small sizes)
- Negative space between the two streams should be legible at 32px
- Corner radius: subtle, ~2px equivalent at default size
- The mark should work independently as an icon (just the "r") and alongside the wordmark

**Wordmark:** "reka" in lowercase Instrument Sans 700, letter-spacing -0.02em. The "r" in the wordmark may optionally be replaced by the logomark at large sizes.

**Favicon:** The logomark "r" with split stream, rendered in Reka Blue on transparent background. Must be legible at 16x16.

**Color usage:**
- Default: Reka Blue `#1B65A7` on white, or `#4A9FE5` on dark backgrounds
- Monochrome: solid black or solid white
- Never: gradients on the logomark, outline-only treatment, rotation

### Icon Style

**Recommended set:** [Lucide Icons](https://lucide.dev/) (outline style, 24px default, 1.5px stroke)

**Why Lucide:** Open source (ISC license), consistent 24px grid, extensive set (1000+), active maintenance, and used by shadcn/ui which aligns with the developer audience. Lighter visual weight than Heroicons, more complete than Feather.

**Custom icon modifications:**
- Use `stroke-width: 1.75px` (slightly heavier than default 1.5px for better visibility in dashboards)
- Icon color follows text color by default; interactive icons use Accent Teal
- Memory-specific icons: use a circle with inner dot for "quarantined" (pause/hold), checkmark-circle for "promoted" (approved)

### Illustration Style

**Style:** Abstract geometric with flowing lines. Think topographic map contours crossed with circuit diagrams.

**Principles:**
- Lines flow left-to-right (data flow direction)
- Use only the brand palette — no additional colors
- Dots/nodes at intersection points represent data points or memories
- Subtle grid underlay (representing infrastructure)
- Animated variants: lines draw themselves in, dots appear with slight delay (stagger 50ms)

**Reference mood:** The visual language of Stripe's documentation illustrations meets the minimalism of Linear's empty states.

**Do not use:** Isometric 3D, cartoon characters, stock photography, AI-generated art, or skeuomorphic elements.

---

## 4. Voice & Tone

### Brand Personality

1. **Precise** — Says exactly what it means. No hand-waving, no ambiguity.
2. **Calm** — Confident without being loud. The product does serious work; the voice reflects that.
3. **Pragmatic** — Cares about what works, not what sounds impressive. Favors clarity over cleverness.
4. **Opinionated** — Has a point of view on memory governance and infrastructure ownership. States it plainly.
5. **Generous** — Shares knowledge freely. Documentation is thorough. Errors are explanatory.

### Writing Style Guidelines

#### Documentation
- Active voice, present tense: "Reka indexes your codebase" not "Your codebase will be indexed by Reka"
- Second person: "you" not "the user"
- Imperative for instructions: "Run `reka index`" not "You should run `reka index`"
- Code examples before prose explanations
- Every feature page starts with a one-sentence definition

#### Marketing / Landing Page
- Short sentences. Generous whitespace.
- Lead with the problem, then the solution
- Concrete numbers over vague claims: "35 MCP tools" not "comprehensive toolkit"
- One idea per section

#### Error Messages / CLI Output
- State what happened, why, and what to do: "Memory rejected: contradicts promoted pattern P-042. Run `reka memory review` to compare."
- Never blame the user
- Never use "oops", "whoops", or faux-casual apology language

#### Social Media / Community
- Direct and helpful
- Share technical insights, not brand platitudes
- OK to be brief; not OK to be vague

### Example Phrases

| Context | Reka says | Reka does NOT say |
|---------|-----------|-------------------|
| README intro | "Reka is self-hosted RAG infrastructure for AI coding assistants." | "Reka is a next-gen AI-powered intelligent memory platform." |
| Feature highlight | "Memories are quarantined until you promote them." | "Our cutting-edge governance pipeline leverages human-in-the-loop workflows." |
| Error message | "Embedding failed: BGE-M3 server unreachable at :8080. Check that the container is running." | "Something went wrong! Please try again later." |
| CLI banner | `reka v1.0.0 — 3 projects indexed, 847 memories governed` | `Welcome to Reka! Your AI memory companion :)` |
| Comparison | "Unlike managed RAG services, Reka runs on your hardware. Your vectors never leave your network." | "We are the BEST and most SECURE RAG solution on the market!" |
| Community reply | "Good catch. That's a bug in the sparse vector batching. Fix is in #247." | "Thanks for the feedback! We'll look into it!" |

### Words to Use

`govern`, `promote`, `quarantine`, `index`, `recall`, `flow`, `isolate`, `self-hosted`, `infrastructure`, `pipeline`, `stream`, `vector`, `embed`, `retrieve`, `configure`, `run`, `plug in`, `swap`, `own`

### Words to Avoid

`revolutionary`, `game-changing`, `next-gen`, `AI-powered` (the product IS AI infrastructure, this is redundant), `smart` (vague), `magic`, `automagically`, `seamless` (overused), `leverage` (jargon), `synergy`, `ecosystem` (unless literally describing a plugin ecosystem), `delightful`, `love` (as in "you'll love this feature"), any emoji in documentation prose

---

## 5. Naming Convention for Sub-products

### Product Tiers

| Tier | Name | Description |
|------|------|-------------|
| Open Source | **Reka** | Core engine. Self-hosted. MIT/Apache 2.0. |
| Pro (paid, self-hosted) | **Reka Pro** | Advanced governance, analytics dashboard, SSO, audit logs. |
| Enterprise | **Reka Enterprise** | Multi-tenant, RBAC, compliance features, priority support. |
| Managed Cloud | **Reka Cloud** | Hosted version. Same engine, managed infrastructure. |

### Component Names

Use `Reka + plain English noun`. No forced metaphors, no separate brand names per feature.

| Component | Name | NOT |
|-----------|------|-----|
| RAG API server | **Reka Server** | Reka Core, Reka Engine |
| MCP integration | **Reka MCP** | Reka Connect, Reka Bridge |
| CLI tool | **Reka CLI** | reka-ctl, rekactl |
| Web dashboard | **Reka Dashboard** | Reka Console, Reka Hub |
| Memory system | **Reka Memory** | Reka Vault, Reka Brain |
| Vector storage | **Reka Vectors** | Reka Store, Reka DB |

### Feature Names

Features are named descriptively, not branded. They are lowercase in prose.

| Feature | Reference as | NOT |
|---------|-------------|-----|
| Memory quarantine/promotion | "memory governance" | "Memory Shield", "TrustGuard" |
| Multi-project isolation | "project isolation" | "Reka Spaces", "Workspaces" |
| Spreading activation recall | "spreading activation" | "Smart Recall", "Deep Recall" |
| Graph-based code navigation | "code graph" | "Reka Graph", "CodeMap" |

### CLI Command Naming

```
reka index          # Index a codebase
reka recall         # Search memories
reka memory list    # List memories
reka memory promote # Promote from quarantine
reka memory forget  # Remove a memory
reka project init   # Set up a new project
reka project stats  # Project statistics
reka server start   # Start the Reka server
reka server status  # Health check
```

Pattern: `reka <noun> <verb>` for resource operations, `reka <verb>` for common actions.

### Version Naming

Semantic versioning only: `v1.2.0`. No codenames, no seasonal names, no animal names. The changelog speaks for itself.

---

## Appendix: Quick Reference Card

```
Brand:        Reka
Tagline:      Memory your AI can trust.
Primary:      #1B65A7 (light) / #4A9FE5 (dark)
Accent:       #38B2AC (light) / #4FD1C5 (dark)
Heading font: Inter 600/700
Body font:    Inter 400/500
Mono font:    JetBrains Mono 400
Display font: Instrument Sans 600/700
Icons:        Lucide, 1.75px stroke
Voice:        Precise, calm, pragmatic, opinionated, generous
```
