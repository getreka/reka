

# Reka Landing Page — Design Specification

## 0. Design Tokens & Foundation

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#0a0e1a` | Page background |
| `--bg-secondary` | `#0f1629` | Card backgrounds, alternate sections |
| `--bg-tertiary` | `#141c32` | Elevated surfaces, hover states |
| `--bg-glass` | `rgba(15, 22, 41, 0.72)` | Glassmorphism panels |
| `--navy-900` | `#0a0e1a` | Deepest background |
| `--navy-800` | `#0f1629` | Section alternates |
| `--navy-700` | `#141c32` | Cards, inputs |
| `--navy-600` | `#1a2540` | Borders, dividers |
| `--navy-500` | `#243052` | Subtle borders |
| `--navy-400` | `#334670` | Muted text on dark |
| `--blue-500` | `#3b82f6` | Primary accent |
| `--blue-400` | `#60a5fa` | Links, interactive |
| `--blue-300` | `#93c5fd` | Highlights |
| `--blue-600` | `#2563eb` | Hover accent |
| `--blue-glow` | `rgba(59, 130, 246, 0.15)` | Glow effects |
| `--blue-glow-strong` | `rgba(59, 130, 246, 0.30)` | Active glow |
| `--amber-500` | `#f59e0b` | CTA primary |
| `--amber-400` | `#fbbf24` | CTA hover |
| `--amber-600` | `#d97706` | CTA active/pressed |
| `--amber-glow` | `rgba(245, 158, 11, 0.20)` | CTA glow |
| `--text-primary` | `#e2e8f0` | Headings, primary text |
| `--text-secondary` | `#94a3b8` | Body copy, descriptions |
| `--text-tertiary` | `#64748b` | Captions, metadata |
| `--text-inverse` | `#0a0e1a` | Text on amber buttons |
| `--green-500` | `#22c55e` | Success, "durable" status |
| `--red-400` | `#f87171` | Quarantine status |
| `--yellow-400` | `#facc15` | Pending review status |
| `--border-default` | `rgba(36, 48, 82, 0.6)` | Card borders |
| `--border-hover` | `rgba(59, 130, 246, 0.4)` | Hover borders |

### Typography

**Font stack:**
- Headings: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Body: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Code: `"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", monospace`

**Font loading:** Preload Inter (weights 400, 500, 600, 700) and JetBrains Mono (400, 500) via `<link rel="preload">`. Use `font-display: swap`. Load from Google Fonts or self-host from `/fonts/` directory.

**Type scale:**

| Token | Size | Weight | Line-height | Letter-spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| `display-xl` | 72px | 700 | 1.05 | -0.03em | Hero H1 |
| `display-lg` | 56px | 700 | 1.1 | -0.025em | Section H2 |
| `display-md` | 40px | 600 | 1.15 | -0.02em | Sub-section H3 |
| `heading-lg` | 28px | 600 | 1.25 | -0.015em | Card headings |
| `heading-md` | 22px | 600 | 1.3 | -0.01em | Feature titles |
| `heading-sm` | 18px | 600 | 1.35 | -0.005em | Small headings |
| `body-lg` | 18px | 400 | 1.7 | 0 | Hero description |
| `body-md` | 16px | 400 | 1.65 | 0 | General body |
| `body-sm` | 14px | 400 | 1.6 | 0 | Captions, metadata |
| `code-lg` | 15px | 400 | 1.6 | 0 | Code blocks |
| `code-sm` | 13px | 400 | 1.5 | 0 | Inline code |
| `label` | 12px | 600 | 1.3 | 0.05em | Badges, pills (uppercase) |
| `nav` | 14px | 500 | 1 | 0.01em | Navigation links |

### Spacing Scale

| Token | Value |
|-------|-------|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |
| `--space-16` | 64px |
| `--space-20` | 80px |
| `--space-24` | 96px |
| `--space-32` | 128px |

### Layout Constants

| Token | Value |
|-------|-------|
| `--container-max` | 1200px |
| `--container-wide` | 1400px |
| `--container-narrow` | 800px |
| `--container-pad-x` | 24px (mobile), 40px (tablet), 80px (desktop) |
| `--border-radius-sm` | 6px |
| `--border-radius-md` | 10px |
| `--border-radius-lg` | 16px |
| `--border-radius-xl` | 24px |
| `--border-radius-full` | 9999px |

### Shadow System

| Token | Value |
|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,0.3)` |
| `--shadow-lg` | `0 8px 32px rgba(0,0,0,0.4)` |
| `--shadow-xl` | `0 16px 64px rgba(0,0,0,0.5)` |
| `--shadow-glow-blue` | `0 0 24px rgba(59,130,246,0.15), 0 0 48px rgba(59,130,246,0.05)` |
| `--shadow-glow-amber` | `0 0 24px rgba(245,158,11,0.2), 0 0 48px rgba(245,158,11,0.08)` |

---

## 1. Page Structure & Layout

### Global Page Container

```
<body>
  background: var(--bg-primary)
  color: var(--text-primary)
  overflow-x: hidden
  -webkit-font-smoothing: antialiased
  -moz-osx-font-smoothing: grayscale
</body>
```

A subtle dot-grid pattern overlays the entire page background:
- Pattern: 1px dots at `rgba(59, 130, 246, 0.06)`, spaced 32px apart
- Applied as a CSS `background-image` repeating pattern on `<body>`
- Does not scroll; fixed via `background-attachment: fixed`

---

### Section 1: Navigation Bar

**Purpose:** Persistent top navigation providing brand identity, page anchors, and primary CTA.

**Dimensions & Position:**
- `position: fixed; top: 0; left: 0; right: 0; z-index: 1000`
- Height: 64px
- On scroll past 20px: add `border-bottom: 1px solid var(--border-default)` and backdrop blur

**Background:**
- Default (at top): `background: transparent`
- Scrolled: `background: rgba(10, 14, 26, 0.85); backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2)`
- Transition between states: `transition: background 0.3s ease, border-color 0.3s ease`

**Layout:**
```
<nav>
  max-width: var(--container-wide) = 1400px
  margin: 0 auto
  padding: 0 40px
  display: flex
  align-items: center
  justify-content: space-between
  height: 64px
</nav>
```

**Left group (brand):**
- Reka logo: SVG monogram, 28px height, `var(--blue-400)` fill
- Logo text "Reka": Inter 20px weight-700 `var(--text-primary)`, margin-left 10px
- Gap between logo icon and text: 10px

**Center group (navigation links):**
- Links: "Features", "How It Works", "Architecture", "Docs", "Community"
- Font: `var(--nav)` (Inter 14px weight-500)
- Color: `var(--text-secondary)`, hover: `var(--text-primary)`
- Spacing between links: 32px (gap)
- Each link has `padding: 8px 0` and an underline indicator on hover:
  - `::after` pseudo-element, `height: 2px`, `background: var(--blue-500)`, `width: 0` to `width: 100%`
  - Transition: `width 0.2s ease`
- Active section link (determined by scroll position): color `var(--text-primary)`, underline visible

**Right group (actions):**
- GitHub star count badge: pill shape, `background: var(--navy-700)`, `border: 1px solid var(--border-default)`, `border-radius: var(--border-radius-full)`, `padding: 6px 14px`
  - GitHub icon (Lucide `github`, 16px) + "Star" text + star count (e.g., "1.2k")
  - Font: Inter 13px weight-500
  - Color: `var(--text-secondary)`, hover: `var(--text-primary)`, hover border: `var(--border-hover)`
  - Transition: `all 0.2s ease`
- "Get Started" button: Primary CTA (see Component Specs below)
  - `margin-left: 16px`

**Responsive:**
- Tablet (< 1024px): Center links hidden. Show hamburger icon (24px, `var(--text-secondary)`) on right, before CTA. Mobile menu slides down from nav with `background: var(--bg-secondary)`, full-width, padding 24px, links stacked vertically with 16px gap.
- Mobile (< 768px): GitHub badge hidden. Only logo + hamburger + CTA visible. CTA shrinks to "Start" label.

---

### Section 2: Hero Section

**Purpose:** Immediate brand impression, value proposition, and primary conversion.

**Dimensions:**
- `min-height: 100vh` (minimum full viewport)
- `padding-top: 160px` (64px nav + 96px breathing room)
- `padding-bottom: 120px`

**Background:**
- Base: `var(--bg-primary)` (#0a0e1a)
- Radial gradient overlay: `radial-gradient(ellipse 80% 60% at 50% 0%, rgba(59, 130, 246, 0.08) 0%, transparent 70%)`
  - This creates a subtle blue glow emanating from the top center
- Additional: Faint horizontal lines (every 80px, 1px, `rgba(59, 130, 246, 0.03)`) to suggest flowing water/data

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  padding: 160px 40px 120px
  display: flex
  flex-direction: column
  align-items: center
  text-align: center
</section>
```

**Content (top to bottom):**

1. **Version badge** (top pill):
   - Text: "v1.0 — Now with Memory Governance"
   - Background: `rgba(59, 130, 246, 0.1)`
   - Border: `1px solid rgba(59, 130, 246, 0.2)`
   - `border-radius: var(--border-radius-full)`
   - `padding: 6px 16px`
   - Font: Inter 13px weight-500, color `var(--blue-400)`
   - `margin-bottom: 32px`
   - A tiny sparkle icon (Lucide `sparkles`, 14px) precedes the text with 6px gap

2. **H1 headline**:
   - Text line 1: "Memory that flows."
   - Text line 2: "Knowledge that stays."
   - Font: `var(--display-xl)` = Inter 72px weight-700, line-height 1.05, letter-spacing -0.03em
   - Color: `var(--text-primary)` (#e2e8f0)
   - The words "flows" and "stays" get a gradient treatment:
     - "flows": `background: linear-gradient(135deg, var(--blue-400), var(--blue-300)); -webkit-background-clip: text; -webkit-text-fill-color: transparent`
     - "stays": `background: linear-gradient(135deg, var(--amber-400), var(--amber-500)); -webkit-background-clip: text; -webkit-text-fill-color: transparent`
   - `max-width: 900px`
   - `margin-bottom: 24px`

3. **Subheadline**:
   - Text: "Self-hosted RAG infrastructure that gives your AI coding assistants persistent memory, semantic search, and knowledge governance — without sending your code to third parties."
   - Font: `var(--body-lg)` = Inter 18px weight-400, line-height 1.7
   - Color: `var(--text-secondary)`
   - `max-width: 640px`
   - `margin-bottom: 48px`

4. **CTA button group** (flex row, gap 16px, center-aligned):
   - Primary: "Deploy in 5 Minutes" (amber CTA, see component spec)
     - Left icon: Lucide `rocket`, 18px
   - Secondary: "View on GitHub" (ghost button, see component spec)
     - Left icon: Lucide `github`, 18px
   - Beneath buttons, a muted line:
     - Text: "Free and open source. MIT Licensed."
     - Font: Inter 13px weight-400, color `var(--text-tertiary)`
     - `margin-top: 16px`

5. **Hero visual** (below CTAs):
   - `margin-top: 80px`
   - `max-width: 1000px; width: 100%`
   - A terminal-style window showing a session with Reka:
     - Window chrome: 3 dots (12px circles: #f87171, #fbbf24, #22c55e) top-left, 12px padding
     - Background: `var(--navy-800)` with `border: 1px solid var(--navy-600))`
     - `border-radius: var(--border-radius-lg)` (16px)
     - `box-shadow: var(--shadow-xl), var(--shadow-glow-blue)`
     - Content is a terminal session (details in Content Wireframe section 4)
     - Height: approximately 420px
     - Overflow hidden, content fades to transparent at bottom via `mask-image: linear-gradient(to bottom, black 70%, transparent 100%)`

**Responsive:**
- Laptop (< 1440px): H1 shrinks to 60px. Max-width hero visual 900px.
- Tablet (< 1024px): H1 shrinks to 48px. Subheadline 16px. CTAs stack vertically (full width, max 360px). Hero visual max-width 100%, height auto.
- Mobile (< 768px): H1 shrinks to 36px. Padding-top 120px. Subheadline 15px. Hero visual border-radius 12px.

---

### Section 3: Problem Statement (3 Pain Points)

**Purpose:** Establish the problem space. Create emotional resonance with developers who have experienced these frustrations.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 600-700px desktop

**Background:**
- `var(--bg-primary)` base
- Top border: subtle gradient line, `height: 1px`, `background: linear-gradient(90deg, transparent, var(--navy-600), transparent)`
- No additional overlays

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  text-align: center (for heading)
</section>
```

**Content:**

1. **Section label** (pill/badge above heading):
   - Text: "THE PROBLEM"
   - Font: `var(--label)` = Inter 12px weight-600 uppercase, letter-spacing 0.05em
   - Color: `var(--blue-400)`
   - `margin-bottom: 16px`

2. **Section heading**:
   - Text: "Your AI assistant forgets everything. Every. Single. Time."
   - Font: `var(--display-lg)` = Inter 56px weight-700, line-height 1.1, letter-spacing -0.025em
   - Color: `var(--text-primary)`
   - `max-width: 800px; margin: 0 auto 64px`

3. **Pain point cards** — 3-column grid:
   ```
   display: grid
   grid-template-columns: repeat(3, 1fr)
   gap: 24px
   ```

   Each card:
   - `background: var(--bg-secondary)` (#0f1629)
   - `border: 1px solid var(--border-default)`
   - `border-radius: var(--border-radius-lg)` (16px)
   - `padding: 40px 32px`
   - `text-align: left`
   - Hover: `border-color: var(--border-hover); transform: translateY(-2px); box-shadow: var(--shadow-md)`. Transition: `all 0.25s ease`

   **Card 1:**
   - Icon container: 48px x 48px, `border-radius: var(--border-radius-md)` (10px), `background: rgba(248, 113, 113, 0.1)`, centered icon: Lucide `brain-cog` 24px in `var(--red-400)` (#f87171)
   - `margin-bottom: 20px`
   - Heading: "Groundhog Day Debugging"
   - Heading font: `var(--heading-md)` = Inter 22px weight-600
   - `margin-bottom: 12px`
   - Body: "You explain the same architectural decisions to your AI assistant every session. It re-discovers patterns you settled months ago. Context windows reset, and so does all the knowledge."
   - Body font: `var(--body-md)`, color `var(--text-secondary)`

   **Card 2:**
   - Icon: Lucide `search-x` 24px in `var(--yellow-400)` (#facc15), icon container background `rgba(250, 204, 21, 0.1)`
   - Heading: "Codebase Blindness"
   - Body: "Your assistant generates code that ignores existing patterns, duplicates utilities already built, and contradicts architectural decisions documented three directories away. It cannot see the forest for the trees."

   **Card 3:**
   - Icon: Lucide `cloud-off` 24px in `var(--blue-400)` (#60a5fa), icon container background `rgba(96, 165, 250, 0.1)`
   - Heading: "Vendor Lock-in & Data Leakage"
   - Body: "Cloud-hosted memory solutions mean your proprietary code, architectural decisions, and internal documentation flow through third-party servers. Compliance teams are not amused. Neither are you."

**Responsive:**
- Tablet (< 1024px): Grid becomes `grid-template-columns: 1fr`. Cards max-width 600px, margin 0 auto. H2 shrinks to 40px.
- Mobile (< 768px): H2 shrinks to 32px. Card padding 28px 24px.

---

### Section 4: How It Works (4-Step Flow)

**Purpose:** Show the simplicity of Reka's workflow. Reduce perceived complexity. Build confidence.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 750-850px desktop

**Background:**
- `var(--bg-secondary)` (#0f1629) — alternate section background for visual rhythm
- Subtle radial gradient: `radial-gradient(ellipse 60% 40% at 50% 100%, rgba(59, 130, 246, 0.05) 0%, transparent 70%)`

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  text-align: center (for heading)
</section>
```

**Content:**

1. **Section label**: "HOW IT WORKS" (same pill style as Section 3)
2. **Section heading**:
   - Text: "From zero to persistent memory in four steps"
   - Font: `var(--display-lg)`, `max-width: 700px; margin: 0 auto 72px`

3. **Steps — horizontal timeline layout:**
   ```
   display: grid
   grid-template-columns: repeat(4, 1fr)
   gap: 32px
   position: relative
   ```

   **Connecting line:** A horizontal line connecting all 4 steps:
   - `position: absolute; top: 28px; left: calc(12.5% + 16px); right: calc(12.5% + 16px); height: 2px`
   - `background: linear-gradient(90deg, var(--blue-500), var(--blue-400), var(--blue-500), var(--blue-400))`
   - `opacity: 0.3`
   - Animated: a small bright dot (8px, `var(--blue-400)`, `box-shadow: var(--shadow-glow-blue)`) travels along this line in a 6-second loop, `animation: flowDot 6s linear infinite`

   Each step:
   - `text-align: center`

   **Step number circle:**
   - 56px x 56px circle, `border-radius: 50%`
   - `background: var(--bg-primary)`
   - `border: 2px solid var(--blue-500)`
   - Number inside: Inter 20px weight-700, color `var(--blue-400)`
   - `margin: 0 auto 24px`
   - `position: relative; z-index: 1` (above the connecting line)

   **Step 1:**
   - Number: "1"
   - Heading: "Deploy"
   - Body: "One `docker-compose up` command. Qdrant, embeddings, and the API spin up in under 60 seconds. No cloud account needed."
   - Code snippet below body: `docker-compose up -d` in inline code style

   **Step 2:**
   - Number: "2"
   - Heading: "Connect"
   - Body: "Point your AI assistant to Reka via MCP. Works with Claude Code, Cursor, Windsurf, or any MCP-compatible client. One JSON config."

   **Step 3:**
   - Number: "3"
   - Heading: "Index"
   - Body: "Reka crawls your codebase, extracts symbols, builds a dependency graph, and creates semantic embeddings. Incremental re-indexing keeps it fresh."

   **Step 4:**
   - Number: "4"
   - Heading: "Remember"
   - Body: "Your assistant now has persistent memory. Decisions carry forward. Patterns are recognized. Context survives across sessions, across days, across teammates."

   Step heading font: `var(--heading-md)` = Inter 22px weight-600, `margin-bottom: 12px`
   Step body font: `var(--body-md)`, color `var(--text-secondary)`, `max-width: 240px; margin: 0 auto`

**Responsive:**
- Tablet (< 1024px): Grid becomes 2x2 (`grid-template-columns: repeat(2, 1fr)`). Connecting line hidden. Step circles get a subtle downward-pointing connector (8px line beneath each circle) instead.
- Mobile (< 768px): Grid becomes single column. Each step has a left-aligned layout with step number circle (40px) inline with heading.

---

### Section 5: Key Features Grid (6 Features)

**Purpose:** Comprehensive feature showcase. Each card is scannable and highlights a specific capability.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 800-900px desktop

**Background:**
- `var(--bg-primary)` base
- Top border: gradient line (same as Section 3)

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  text-align: center (heading)
</section>
```

**Content:**

1. **Section label**: "FEATURES"
2. **Section heading**:
   - Text: "Everything your AI assistant needs to truly understand your codebase"
   - `max-width: 750px; margin: 0 auto 64px`

3. **Feature cards — 3x2 grid:**
   ```
   display: grid
   grid-template-columns: repeat(3, 1fr)
   gap: 24px
   ```

   Each card:
   - `background: var(--bg-secondary)`
   - `border: 1px solid var(--border-default)`
   - `border-radius: var(--border-radius-lg)` (16px)
   - `padding: 36px 28px`
   - `text-align: left`
   - Top-left: colored icon in icon container (see pattern from Section 3)
   - Hover: border color transitions to a color matching the card's accent, `transform: translateY(-3px)`, `box-shadow: var(--shadow-lg)`
   - Transition: `all 0.3s cubic-bezier(0.4, 0, 0.2, 1)`

   **Card 1: Semantic Code Search**
   - Icon: Lucide `search-code` 24px, accent: `var(--blue-400)`, bg: `rgba(96, 165, 250, 0.1)`
   - Heading: "Semantic Code Search"
   - Body: "Hybrid search combining vector similarity and keyword matching. Find code by describing what it does, not just what it is named. BM25 + dense embeddings with reciprocal rank fusion."
   - Bottom detail: A mini code snippet badge: `hybrid_search("retry logic with backoff")` in code font, `background: var(--navy-700)`, `border-radius: 6px`, `padding: 8px 12px`, `margin-top: 16px`

   **Card 2: Dependency Graph**
   - Icon: Lucide `git-graph` 24px, accent: `var(--green-500)`, bg: `rgba(34, 197, 94, 0.1)`
   - Heading: "Dependency Graph"
   - Body: "Automatically maps imports, extends, and implements relationships across your codebase. Trace blast radius before refactoring. N-hop expansion reveals hidden coupling."

   **Card 3: Memory Governance**
   - Icon: Lucide `shield-check` 24px, accent: `var(--amber-500)`, bg: `rgba(245, 158, 11, 0.1)`
   - Badge on card: "USP" pill, top-right corner, `background: rgba(245, 158, 11, 0.15)`, `color: var(--amber-400)`, `border-radius: var(--border-radius-full)`, `padding: 4px 10px`, font `var(--label)`
   - Heading: "Memory Governance"
   - Body: "Not all memories are equal. Auto-generated memories enter quarantine. Human-verified knowledge becomes durable. Contradictions are detected and resolved. Your knowledge base stays clean."

   **Card 4: Symbol Index**
   - Icon: Lucide `braces` 24px, accent: `var(--blue-300)`, bg: `rgba(147, 197, 253, 0.1)`
   - Heading: "Symbol Index"
   - Body: "Instant lookup of functions, classes, types, and interfaces by name. Faster than grep, smarter than tree-sitter alone. Supports TypeScript, Python, Go, Rust, Java, and more."

   **Card 5: MCP Native**
   - Icon: Lucide `plug-zap` 24px, accent: `var(--yellow-400)`, bg: `rgba(250, 204, 21, 0.1)`
   - Heading: "MCP Native"
   - Body: "Built from the ground up for the Model Context Protocol. 35 tools that integrate natively with Claude Code, Cursor, Windsurf, and any MCP-compatible client. No adapters, no shims."

   **Card 6: Multi-Project Isolation**
   - Icon: Lucide `layers` 24px, accent: `#a78bfa` (purple-400), bg: `rgba(167, 139, 250, 0.1)`
   - Heading: "Multi-Project Isolation"
   - Body: "One infrastructure, unlimited projects. Each project gets namespaced vector collections, isolated memory stores, and independent dependency graphs. Share the server, never the data."

**Responsive:**
- Laptop (< 1440px): Grid stays 3-column, gap reduces to 20px.
- Tablet (< 1024px): `grid-template-columns: repeat(2, 1fr)`.
- Mobile (< 768px): `grid-template-columns: 1fr`. Cards max-width 480px, centered.

---

### Section 6: Memory Governance Deep Dive (USP Section)

**Purpose:** This is Reka's key differentiator. This section gets premium real estate and visual treatment to communicate the memory lifecycle.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 900-1000px desktop

**Background:**
- `var(--bg-secondary)` (#0f1629) base
- Radial gradient: `radial-gradient(ellipse 70% 50% at 50% 50%, rgba(245, 158, 11, 0.04) 0%, transparent 70%)`
- Left and right edges: faint vertical flowing lines (SVG or CSS) suggesting data flow, animated slowly upward, `opacity: 0.05`, color `var(--blue-400)`

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
</section>
```

Two-part layout: heading + intro (centered), then a split layout (text left, visual right).

**Content:**

1. **Section label**: "MEMORY GOVERNANCE"
2. **Section heading**:
   - Text: "Not all knowledge deserves permanence"
   - Font: `var(--display-lg)`, `text-align: center; max-width: 700px; margin: 0 auto 24px`
3. **Section intro**:
   - Text: "AI assistants generate memories constantly — but hallucinated patterns and stale decisions pollute your knowledge base over time. Reka introduces a governance layer inspired by how human memory actually works."
   - Font: `var(--body-lg)`, color `var(--text-secondary)`, `text-align: center; max-width: 640px; margin: 0 auto 72px`

4. **Split layout:**
   ```
   display: grid
   grid-template-columns: 1fr 1fr
   gap: 64px
   align-items: center
   ```

   **Left column — Memory lifecycle stages:**

   Three stages, vertically stacked, with connecting lines between them:

   **Stage 1: Quarantine**
   - Left indicator: vertical bar, 4px wide, 100% height of stage block, `background: var(--red-400)`, `border-radius: 2px`
   - Stage heading: "Quarantine" with a status pill: "Auto-generated" in `var(--red-400)`, bg `rgba(248, 113, 113, 0.1)`
   - Description: "Every auto-generated memory starts here. Marked with a confidence score and source attribution. Quarantined memories are available for recall but flagged as unverified."
   - Font: heading `var(--heading-sm)` (18px weight-600), body `var(--body-md)` color `var(--text-secondary)`
   - `padding: 24px; padding-left: 20px; margin-left: 16px` (offset from bar)

   Connecting arrow: downward, 32px tall, `var(--navy-500)`, dashed (4px dash, 4px gap)

   **Stage 2: Review**
   - Left indicator: vertical bar, `background: var(--yellow-400)`
   - Stage heading: "Review" with pill: "Pending validation"
   - Description: "Contradiction detection automatically flags memories that conflict with existing knowledge. Stale memories past their TTL surface for re-evaluation. Duplicates are merged."

   Connecting arrow: downward, same style

   **Stage 3: Durable**
   - Left indicator: vertical bar, `background: var(--green-500)`
   - Stage heading: "Durable" with pill: "Human-verified"
   - Description: "Manually created memories and reviewed auto-memories graduate to durable status. These form your project's canonical knowledge base — architectural decisions, established patterns, verified insights."

   **Right column — Visual:**
   A stylized card stack showing the memory lifecycle:
   - Three overlapping cards (slightly offset, like a fanned deck)
   - Card at back (quarantine): `border-left: 3px solid var(--red-400)`, slightly rotated (-2deg), opacity 0.7
   - Card in middle (review): `border-left: 3px solid var(--yellow-400)`, rotated (-1deg), opacity 0.85
   - Card in front (durable): `border-left: 3px solid var(--green-500)`, straight, full opacity
   - Each card: `background: var(--navy-700)`, `border: 1px solid var(--navy-600)`, `border-radius: 12px`, `padding: 20px`
   - The front card content shows a realistic memory entry:
     ```
     type: "pattern"
     status: "durable"  ← green text
     content: "Use repository pattern for all
                database access. Direct Qdrant
                client calls only in vector-store.ts"
     confidence: 0.94
     source: "human"
     created: "2025-01-15"
     ```
   - Code font (`var(--code-lg)`), syntax-highlighted with appropriate colors

   This visual has a subtle floating animation: `animation: float 6s ease-in-out infinite` (3px up/down translateY)

**Responsive:**
- Tablet (< 1024px): Split layout becomes single column. Visual moves above the stages. `gap: 48px`.
- Mobile (< 768px): H2 shrinks to 32px. Stages get reduced padding (16px). Visual hidden (too complex for small screens; replaced with a simple 3-step horizontal progress bar: red dot → yellow dot → green dot with labels).

---

### Section 7: Architecture Diagram

**Purpose:** Build trust through transparency. Show developers exactly what they are deploying.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 800-900px desktop

**Background:**
- `var(--bg-primary)` base
- Faint blueprint-style grid: `background-image: linear-gradient(var(--navy-600) 1px, transparent 1px), linear-gradient(90deg, var(--navy-600) 1px, transparent 1px); background-size: 40px 40px; opacity: 0.15`

**Layout:**
```
<section>
  max-width: var(--container-wide) = 1400px
  margin: 0 auto
  text-align: center
</section>
```

**Content:**

1. **Section label**: "ARCHITECTURE"
2. **Section heading**:
   - Text: "Transparent by design. No black boxes."
   - `max-width: 600px; margin: 0 auto 64px`

3. **Architecture diagram:**

   This is a styled SVG/HTML diagram (not an image). Built with positioned `<div>` elements connected by SVG `<path>` lines. Full width of container (1400px max), approximately 500px tall.

   **Diagram nodes (styled boxes):**

   Each node is a card:
   - `background: var(--bg-secondary)`
   - `border: 1px solid var(--navy-600)`
   - `border-radius: var(--border-radius-md)` (10px)
   - `padding: 16px 20px`
   - Min-width: 160px
   - Icon (24px) + label (Inter 14px weight-600) + subtitle (Inter 12px weight-400, `var(--text-tertiary)`)
   - Hover: `border-color: var(--blue-500); box-shadow: var(--shadow-glow-blue)`. Transition: `all 0.2s ease`
   - On hover, a tooltip appears (see Tooltip component spec) with tech details

   **Nodes layout (3 tiers):**

   **Top tier (clients):**
   - "Claude Code" (icon: terminal) — position: left-third
   - "Cursor" (icon: mouse-pointer) — position: center
   - "Any MCP Client" (icon: plug) — position: right-third
   - These connect downward to the MCP Server node

   **Middle tier (Reka core):**
   - "MCP Server" — spanning center, `border-color: var(--blue-500)`, slightly larger (min-width 200px)
     - Subtitle: "35 tools / project isolation"
   - Below it, connected: "RAG API" — `border-color: var(--blue-400)`
     - Subtitle: "Express :3100 / TypeScript"

   **Bottom tier (infrastructure):**
   - "Qdrant" (icon: database) — left position
     - Subtitle: "Vectors :6333"
   - "Ollama / LLM" (icon: brain) — center-left
     - Subtitle: "Local inference :11434"
   - "BGE-M3" (icon: cpu) — center-right
     - Subtitle: "Embeddings :8080"
   - "Redis" (icon: hard-drive) — right position
     - Subtitle: "Cache :6380"

   **Connections:**
   - SVG paths with `stroke: var(--navy-500); stroke-width: 1.5; fill: none`
   - Animated dashes: `stroke-dasharray: 6 4; animation: dashFlow 1.5s linear infinite`
   - `@keyframes dashFlow { to { stroke-dashoffset: -10; } }`
   - Arrow heads: small triangles (6px) at endpoints, filled `var(--navy-400)`

   **Labels on connections:**
   - Between clients and MCP: "MCP Protocol"
   - Between MCP and RAG API: "HTTP / X-Project-Name header"
   - Font: Inter 11px weight-400, color `var(--text-tertiary)`, placed along the path

**Responsive:**
- Tablet (< 1024px): Diagram scales down. Nodes reduce min-width to 130px. Font sizes reduce by 1px. Connection labels hidden.
- Mobile (< 768px): Diagram replaced with a simplified vertical stack — nodes listed top-to-bottom with downward arrows between them. Each node is full-width, stacked with 12px gap.

---

### Section 8: Comparison Table

**Purpose:** Competitive positioning. Show why Reka is the right choice for self-hosted scenarios.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 700-800px desktop

**Background:**
- `var(--bg-secondary)` (#0f1629)

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  text-align: center (heading)
</section>
```

**Content:**

1. **Section label**: "COMPARISON"
2. **Section heading**:
   - Text: "How Reka compares"
   - `max-width: 500px; margin: 0 auto 64px`

3. **Comparison table:**
   - `width: 100%`
   - `border-radius: var(--border-radius-lg)` (16px)
   - `overflow: hidden`
   - `border: 1px solid var(--border-default)`

   **Table header row:**
   - `background: var(--navy-700)`
   - `padding: 16px 24px` per cell
   - Font: Inter 14px weight-600, color `var(--text-primary)`
   - Columns: "Feature", "Reka", "Mem0", "Zep", "Custom RAG"
   - The "Reka" column header has a subtle glow: `background: rgba(59, 130, 246, 0.08)`, and the text is `var(--blue-400)`

   **Table body rows:**
   - Alternating backgrounds: even `var(--bg-secondary)`, odd `var(--navy-700)` at 50% opacity
   - `padding: 14px 24px` per cell
   - Font: Inter 14px weight-400, color `var(--text-secondary)`
   - Row hover: `background: rgba(59, 130, 246, 0.04)`
   - The "Reka" column cells have text in `var(--text-primary)` (brighter for emphasis)

   **Row data:**

   | Feature | Reka | Mem0 | Zep | Custom RAG |
   |---------|------|------|-----|------------|
   | Self-hosted | checkmark (green) | partial (yellow) | checkmark (green) | checkmark (green) |
   | Memory governance | checkmark (green) | cross (red) | cross (red) | cross (red) |
   | MCP native | checkmark (green) | cross (red) | cross (red) | cross (red) |
   | Dependency graph | checkmark (green) | cross (red) | cross (red) | partial (yellow) |
   | Multi-project | checkmark (green) | checkmark (green) | partial (yellow) | cross (red) |
   | Semantic search | checkmark (green) | checkmark (green) | checkmark (green) | partial (yellow) |
   | Code-aware chunking | checkmark (green) | cross (red) | cross (red) | partial (yellow) |
   | Setup time | "5 min" | "30 min" | "15 min" | "Days" |
   | Cost | "Free" badge (green bg) | "$" | "$$" | "Time" |

   **Checkmark/cross icons:**
   - Checkmark: Lucide `check` 16px in `var(--green-500)`, wrapped in 24px circle with `background: rgba(34, 197, 94, 0.1)`
   - Cross: Lucide `x` 16px in `var(--red-400)`, wrapped in 24px circle with `background: rgba(248, 113, 113, 0.1)`
   - Partial: Lucide `minus` 16px in `var(--yellow-400)`, wrapped in 24px circle with `background: rgba(250, 204, 21, 0.1)`

   **"Free" badge:** `background: rgba(34, 197, 94, 0.15); color: var(--green-500); border-radius: var(--border-radius-full); padding: 4px 12px; font: var(--label)`

**Responsive:**
- Tablet (< 1024px): Table scrolls horizontally. `overflow-x: auto` on container. First column is `position: sticky; left: 0; background: var(--bg-secondary); z-index: 1`.
- Mobile (< 768px): Same as tablet. Column widths: first col 140px, others min 120px. Font sizes reduce to 13px.

---

### Section 9: Quick Start / Installation

**Purpose:** Remove friction. Give developers the exact commands to get started immediately.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 700-800px desktop

**Background:**
- `var(--bg-primary)` base
- Radial gradient: `radial-gradient(ellipse 60% 40% at 50% 50%, rgba(59, 130, 246, 0.05) 0%, transparent 70%)`

**Layout:**
```
<section>
  max-width: var(--container-narrow) = 800px
  margin: 0 auto
  text-align: center (heading)
</section>
```

**Content:**

1. **Section label**: "QUICK START"
2. **Section heading**:
   - Text: "Up and running in three commands"
   - `margin: 0 auto 48px`

3. **Terminal code block:**
   - `max-width: 700px; margin: 0 auto`
   - Window chrome (3 dots), `background: var(--navy-800)`, `border: 1px solid var(--navy-600)`, `border-radius: var(--border-radius-lg)` (16px)
   - `padding: 28px 32px` (content area, below window chrome)
   - `box-shadow: var(--shadow-lg)`

   **Terminal content:**
   ```
   # Clone and start Reka
   git clone https://github.com/reka-ai/reka.git
   cd reka && docker-compose up -d

   # Configure your MCP client
   cat > .mcp.json << 'EOF'
   {
     "mcpServers": {
       "reka": {
         "command": "node",
         "args": ["./mcp-server/dist/index.js"],
         "env": {
           "PROJECT_NAME": "my-project",
           "RAG_API_URL": "http://localhost:3100"
         }
       }
     }
   }
   EOF

   # Index your codebase
   curl -X POST http://localhost:3100/api/index \
     -H "X-Project-Name: my-project" \
     -H "Content-Type: application/json" \
     -d '{"path": "/path/to/your/code"}'
   ```

   **Syntax highlighting:**
   - Comments (`#`): `var(--text-tertiary)` (#64748b)
   - Commands (`git`, `cd`, `docker-compose`, `cat`, `curl`): `var(--blue-400)` (#60a5fa)
   - Flags (`-X`, `-H`, `-d`, `up`, `clone`): `var(--text-secondary)` (#94a3b8)
   - Strings (URLs, quoted values): `var(--green-500)` (#22c55e)
   - JSON keys: `var(--amber-400)` (#fbbf24)
   - JSON values: `var(--green-500)`
   - Operators (`<<`, `>`, `|`): `var(--text-tertiary)`

   **Copy button:**
   - Position: `absolute; top: 16px; right: 16px` (within window chrome area)
   - Icon: Lucide `copy` 16px, color `var(--text-tertiary)`
   - Hover: color `var(--text-primary)`, `background: var(--navy-600)`, `border-radius: 6px`, `padding: 6px`
   - Click: icon changes to Lucide `check` 16px in `var(--green-500)` for 2 seconds, then reverts

4. **Below the terminal, a row of requirement badges:**
   - `display: flex; gap: 12px; justify-content: center; margin-top: 24px`
   - Each badge: `background: var(--navy-700)`, `border: 1px solid var(--border-default)`, `border-radius: var(--border-radius-full)`, `padding: 6px 14px`
   - Font: Inter 13px weight-500, color `var(--text-secondary)`
   - Badges: "Docker 24+", "8GB RAM", "Node 18+", "~2GB disk"

**Responsive:**
- Tablet/Mobile: Code block takes full width. `padding: 20px 16px`. Font size reduces to 13px. Horizontal scroll on code if needed (`overflow-x: auto; white-space: pre`).

---

### Section 10: Open Source & Community

**Purpose:** Build trust, encourage contribution, show project health.

**Dimensions:**
- `padding: 120px 40px`
- Approximate height: 500-600px desktop

**Background:**
- `var(--bg-secondary)` (#0f1629)

**Layout:**
```
<section>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
  text-align: center
</section>
```

**Content:**

1. **Section label**: "OPEN SOURCE"
2. **Section heading**:
   - Text: "Built in the open. Shaped by developers."
   - `max-width: 600px; margin: 0 auto 24px`
3. **Section description**:
   - Text: "Reka is MIT licensed and always will be. No open-core bait-and-switch. No enterprise edition hiding the good parts. Every feature, every line of code, available to everyone."
   - Font: `var(--body-lg)`, color `var(--text-secondary)`, `max-width: 600px; margin: 0 auto 48px`

4. **Stats row:**
   ```
   display: flex
   justify-content: center
   gap: 48px
   margin-bottom: 48px
   ```

   Each stat:
   - Number: Inter 40px weight-700, color `var(--text-primary)` (e.g., "35+", "12k", "150+", "MIT")
   - Label below: Inter 14px weight-400, color `var(--text-tertiary)` (e.g., "MCP Tools", "GitHub Stars", "Contributors", "License")
   - `text-align: center`

5. **Action cards — 3 columns:**
   ```
   display: grid
   grid-template-columns: repeat(3, 1fr)
   gap: 24px
   ```

   **Card 1: Contribute**
   - Icon: Lucide `git-pull-request` 24px, `var(--blue-400)`
   - Heading: "Contribute"
   - Body: "Pick up a good-first-issue, improve docs, or add a new parser. Every PR gets a thoughtful review within 48 hours."
   - Link: "View open issues →" in `var(--blue-400)`, hover underline

   **Card 2: Discuss**
   - Icon: Lucide `message-circle` 24px, `var(--blue-400)`
   - Heading: "Discuss"
   - Body: "Join the conversation on GitHub Discussions. Share your setup, request features, or help other developers get started."
   - Link: "Join discussions →"

   **Card 3: Stay Updated**
   - Icon: Lucide `bell-ring` 24px, `var(--blue-400)`
   - Heading: "Stay Updated"
   - Body: "Star the repo to get release notifications. We ship updates every two weeks with a detailed changelog."
   - Link: "Star on GitHub →"

   Cards follow the same styling pattern as feature cards (Section 5) but without colored icon containers — just the icon directly.

**Responsive:**
- Tablet (< 1024px): Stats row wraps to 2x2. Action cards become single column.
- Mobile (< 768px): Stats font reduces to 32px. Gap between stats reduces to 32px.

---

### Section 11: Footer

**Purpose:** Navigation, legal, brand reinforcement.

**Dimensions:**
- `padding: 64px 40px 32px`
- Approximate height: 280px desktop

**Background:**
- `var(--bg-primary)` (#0a0e1a)
- Top border: `1px solid var(--navy-600)`

**Layout:**
```
<footer>
  max-width: var(--container-max) = 1200px
  margin: 0 auto
</footer>
```

**Content:**

**Top row — 4 columns:**
```
display: grid
grid-template-columns: 2fr 1fr 1fr 1fr
gap: 48px
margin-bottom: 48px
```

**Column 1 (brand):**
- Reka logo + text (same as nav, but logo is 24px height)
- Tagline: "Memory that flows. Knowledge that stays."
  - Font: Inter 14px weight-400, color `var(--text-tertiary)`, `margin-top: 12px`
- Social icons row (margin-top 20px):
  - GitHub, Discord, Twitter/X icons
  - 20px each, color `var(--text-tertiary)`, hover `var(--text-primary)`
  - Gap: 16px

**Column 2 (Product):**
- Heading: "Product" — Inter 14px weight-600, color `var(--text-primary)`, `margin-bottom: 16px`
- Links: "Features", "Architecture", "Documentation", "Changelog", "Roadmap"
- Each: Inter 14px weight-400, color `var(--text-tertiary)`, hover `var(--text-secondary)`. Line-height: 2.2 (generous spacing)

**Column 3 (Developers):**
- Heading: "Developers"
- Links: "Quick Start", "API Reference", "MCP Integration", "Self-Hosting Guide", "Contributing"

**Column 4 (Community):**
- Heading: "Community"
- Links: "GitHub Discussions", "Discord Server", "Twitter", "Blog", "Release Notes"

**Bottom row:**
```
display: flex
justify-content: space-between
align-items: center
padding-top: 24px
border-top: 1px solid var(--navy-600)
```

- Left: "© 2025 Reka Contributors. MIT License." — Inter 13px weight-400, color `var(--text-tertiary)`
- Right: "Privacy Policy" · "Terms" — Inter 13px, color `var(--text-tertiary)`, links separated by `·` (middle dot) with 12px gap

**Responsive:**
- Tablet (< 1024px): Grid becomes 2x2. Brand column spans full width on top.
- Mobile (< 768px): Single column. All columns stacked. Bottom row stacks vertically, centered.

---

## 2. Component Specifications

### Navigation Bar

Fully specified in Section 1 above. Key additions:

**Scroll progress indicator:**
- `position: fixed; top: 64px; left: 0; right: 0; height: 2px; z-index: 999`
- `background: linear-gradient(90deg, var(--blue-500), var(--amber-500))`
- Width: dynamically set via JS to `(scrollY / (docHeight - viewportHeight)) * 100%`
- `transform-origin: left`
- Only visible when page has scrolled past hero section (opacity 0 to 1 transition over 0.3s)

---

### CTA Buttons

**Primary (Amber):**
- `background: var(--amber-500)` (#f59e0b)
- `color: var(--text-inverse)` (#0a0e1a)
- `border: none`
- `border-radius: var(--border-radius-md)` (10px)
- `padding: 14px 28px`
- `font: Inter 15px weight-600`
- `cursor: pointer`
- `display: inline-flex; align-items: center; gap: 8px`
- `box-shadow: var(--shadow-glow-amber)`
- Hover: `background: var(--amber-400)` (#fbbf24), `box-shadow: 0 0 32px rgba(245, 158, 11, 0.3), 0 0 64px rgba(245, 158, 11, 0.1)`, `transform: translateY(-1px)`
- Active: `background: var(--amber-600)` (#d97706), `transform: translateY(0px)`, `box-shadow: var(--shadow-glow-amber)`
- Transition: `all 0.2s cubic-bezier(0.4, 0, 0.2, 1)`
- Focus-visible: `outline: 2px solid var(--amber-400); outline-offset: 2px`

**Secondary (Ghost/outline):**
- `background: transparent`
- `color: var(--text-primary)`
- `border: 1px solid var(--navy-500)` (#243052)
- `border-radius: var(--border-radius-md)` (10px)
- `padding: 13px 27px` (1px less than primary to account for border)
- `font: Inter 15px weight-500`
- `display: inline-flex; align-items: center; gap: 8px`
- Hover: `border-color: var(--blue-500); color: var(--blue-400); background: rgba(59, 130, 246, 0.05)`
- Active: `background: rgba(59, 130, 246, 0.1)`
- Transition: `all 0.2s ease`

**Ghost (text-only with hover background):**
- `background: transparent; border: none`
- `color: var(--text-secondary)`
- `padding: 8px 16px`
- `border-radius: var(--border-radius-sm)` (6px)
- `font: Inter 14px weight-500`
- Hover: `color: var(--text-primary); background: var(--navy-700)`
- Transition: `all 0.15s ease`

---

### Feature Cards

Specified in Section 5. Additional hover detail:

**Hover state transition:**
```css
.feature-card {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              border-color 0.3s ease;
}
.feature-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px var(--border-hover);
  border-color: var(--border-hover);
}
```

**Icon container pattern (reused across sections):**
```css
.icon-container {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  /* background and icon color set per-instance */
}
```

---

### Code Blocks (Terminal Style)

**Outer container:**
- `background: var(--navy-800)` (#0f1629)
- `border: 1px solid var(--navy-600)` (#1a2540)
- `border-radius: var(--border-radius-lg)` (16px)
- `overflow: hidden`
- `box-shadow: var(--shadow-lg)`

**Window chrome bar:**
- `height: 44px`
- `padding: 0 16px`
- `display: flex; align-items: center; gap: 8px`
- `background: var(--navy-700)` (#141c32)
- `border-bottom: 1px solid var(--navy-600)`
- Three dots: 12px diameter circles
  - Red: `#f87171` (close)
  - Yellow: `#fbbf24` (minimize)
  - Green: `#22c55e` (maximize)
  - Gap between dots: 8px

**Code content area:**
- `padding: 24px 28px`
- `font-family: "JetBrains Mono", monospace`
- `font-size: 14px (var(--code-lg) minus 1px for blocks)`
- `line-height: 1.65`
- `overflow-x: auto`
- `white-space: pre`
- `-webkit-overflow-scrolling: touch`

**Custom scrollbar:**
```css
.code-block::-webkit-scrollbar { height: 6px; }
.code-block::-webkit-scrollbar-track { background: transparent; }
.code-block::-webkit-scrollbar-thumb { background: var(--navy-500); border-radius: 3px; }
.code-block::-webkit-scrollbar-thumb:hover { background: var(--navy-400); }
```

---

### Comparison Table

Specified in Section 8. Additional component details:

**Table cell hover indicator (Reka column):**
- The entire "Reka" column has a faint persistent highlight: `background: rgba(59, 130, 246, 0.03)`
- On row hover, the Reka cell gets slightly brighter: `background: rgba(59, 130, 246, 0.07)`

---

### Section Headings (reusable pattern)

```
.section-label {
  display: inline-block;
  font: var(--label);  /* 12px 600 uppercase */
  color: var(--blue-400);
  letter-spacing: 0.05em;
  margin-bottom: 16px;
}

.section-heading {
  font: var(--display-lg);  /* 56px 700 */
  color: var(--text-primary);
  max-width: varies-per-section;
  margin: 0 auto var(--space-16);
}
```

---

### Badges / Pills

**Default pill:**
- `display: inline-flex; align-items: center; gap: 6px`
- `background: rgba(59, 130, 246, 0.1)`
- `border: 1px solid rgba(59, 130, 246, 0.2)`
- `border-radius: var(--border-radius-full)`
- `padding: 6px 16px`
- `font: Inter 13px weight-500; color: var(--blue-400)`

**Status pills (used in Memory Governance):**
- Quarantine: bg `rgba(248, 113, 113, 0.1)`, border `rgba(248, 113, 113, 0.2)`, text `var(--red-400)`
- Pending: bg `rgba(250, 204, 21, 0.1)`, border `rgba(250, 204, 21, 0.2)`, text `var(--yellow-400)`
- Durable: bg `rgba(34, 197, 94, 0.1)`, border `rgba(34, 197, 94, 0.2)`, text `var(--green-500)`

---

### Tooltips

- `position: absolute` (relative to hovered element)
- `background: var(--navy-700)`
- `border: 1px solid var(--navy-500)`
- `border-radius: var(--border-radius-sm)` (6px)
- `padding: 8px 12px`
- `font: Inter 13px weight-400; color: var(--text-secondary)`
- `box-shadow: var(--shadow-md)`
- `white-space: nowrap` (or max-width 240px with wrapping)
- `z-index: 100`
- `pointer-events: none`
- Arrow: 6px CSS triangle pointing toward the trigger element
- Enter: `opacity 0→1, translateY(4px→0)`, duration 0.15s, ease
- Exit: `opacity 1→0`, duration 0.1s

---

### Footer Links

- `font: Inter 14px weight-400`
- `color: var(--text-tertiary)`
- `text-decoration: none`
- `line-height: 2.2`
- `display: block`
- Hover: `color: var(--text-secondary)`
- Transition: `color 0.15s ease`

---

## 3. Animation & Interaction Specification

### A. Hero Section Entrance

**Trigger:** Page load (runs once)

**Sequence:**

| Element | Animation | Delay | Duration | Easing |
|---------|-----------|-------|----------|--------|
| Version badge | fadeInUp (opacity 0→1, translateY 16px→0) | 0ms | 600ms | `cubic-bezier(0.16, 1, 0.3, 1)` |
| H1 line 1 | fadeInUp | 100ms | 700ms | same |
| H1 line 2 | fadeInUp | 200ms | 700ms | same |
| Subheadline | fadeInUp | 350ms | 600ms | same |
| CTA buttons | fadeInUp | 500ms | 500ms | same |
| "Free and open source" text | fadeIn (opacity only) | 650ms | 400ms | ease |
| Hero terminal | fadeInUp + subtle scale (0.97→1) | 700ms | 800ms | `cubic-bezier(0.16, 1, 0.3, 1)` |

**Implementation:** CSS `@keyframes` with `animation-fill-mode: both`. No library needed.

```css
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

---

### B. Pain Point Cards Stagger Reveal

**Trigger:** Intersection Observer, threshold 0.2 (20% of section visible)

**Animation per card:**
- Type: fadeInUp (opacity 0→1, translateY 24px→0)
- Duration: 500ms
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)`
- Stagger: 150ms between cards (card 1: 0ms, card 2: 150ms, card 3: 300ms)
- `animation-fill-mode: both` (cards start invisible)

**Implementation:** CSS with Intersection Observer toggling a `.visible` class on the section. Cards use `animation-delay` via CSS custom properties: `style="--stagger: 0"`, `style="--stagger: 1"`, etc.

```css
.pain-card {
  opacity: 0;
  transform: translateY(24px);
}
.section-visible .pain-card {
  animation: fadeInUp 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--stagger) * 150ms);
}
```

---

### C. How-It-Works Step Progression

**Trigger:** Intersection Observer, threshold 0.3

**Connecting line dot animation:**
```css
@keyframes flowDot {
  0% { left: 0; opacity: 0; }
  5% { opacity: 1; }
  95% { opacity: 1; }
  100% { left: 100%; opacity: 0; }
}
```
- Dot: 8px circle, `background: var(--blue-400)`, `box-shadow: 0 0 12px rgba(59, 130, 246, 0.5)`
- Duration: 6s, linear, infinite
- Runs only when section is in viewport (paused via `animation-play-state: paused` when not visible)

**Step reveal:**
- Each step: fadeInUp, 400ms duration
- Stagger: 200ms (step 1: 0ms, step 2: 200ms, step 3: 400ms, step 4: 600ms)
- Step number circles scale from 0.8 to 1.0 with a slight bounce: `cubic-bezier(0.34, 1.56, 0.64, 1)`

---

### D. Feature Cards Hover Effects

**Trigger:** Mouse hover (CSS only, no JS needed)

```css
.feature-card {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              border-color 0.3s ease;
}

.feature-card:hover {
  transform: translateY(-3px);
  border-color: var(--border-hover);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4),
              0 0 0 1px rgba(59, 130, 246, 0.15);
}

.feature-card:hover .icon-container {
  transform: scale(1.05);
  transition: transform 0.3s ease;
}
```

**Feature cards scroll reveal:**
- Trigger: Intersection Observer, threshold 0.15
- Cards reveal in staggered grid order (row by row, left to right)
- Stagger: 100ms between cards
- Animation: fadeInUp, 500ms, `cubic-bezier(0.16, 1, 0.3, 1)`

---

### E. Memory Governance Flow Animation

**Trigger:** Intersection Observer on Section 6, threshold 0.3

**Card stack animation (right column):**
1. Initially, all three cards are stacked and identical (neutral border)
2. At 0ms: back card slides left slightly (-8px) and gets red border, opacity goes to 0.7
3. At 400ms: middle card shifts (-4px), yellow border, opacity 0.85
4. At 800ms: front card slides into final position, green border, full opacity
5. After 1200ms: content in front card types in character by character (typing effect, see below)

**Typing effect on front card content:**
- Characters appear one by one at 30ms intervals
- Cursor: blinking `|` character, `animation: blink 0.8s step-end infinite`
- After all text typed, cursor blinks 3 more times then disappears

**Left column stages:**
- Each stage block: fadeInLeft (translateX -20px→0, opacity 0→1), 500ms
- Stagger: 300ms between stages
- Connecting arrows: draw-in effect (scaleY 0→1, transform-origin top), 200ms, after the stage above finishes

**Floating animation on card stack (post-entrance):**
```css
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
/* Applied after entrance animation completes */
.card-stack.entered { animation: float 6s ease-in-out infinite; }
```

**Implementation:** CSS animations for entrance + float. Typing effect requires minimal JS (or a `<Typewriter>` React component). Intersection Observer for trigger.

---

### F. Architecture Diagram Interactions

**Trigger:** Hover on individual nodes

**Node hover:**
- `border-color: var(--blue-500)`
- `box-shadow: var(--shadow-glow-blue)`
- Connected lines brighten: `stroke: var(--blue-400); stroke-width: 2`
- Tooltip appears (see Tooltip component spec)
- Transition: 0.2s ease

**Animated connections (always running when in view):**
```css
@keyframes dashFlow {
  to { stroke-dashoffset: -10; }
}
.connection-path {
  stroke-dasharray: 6 4;
  animation: dashFlow 1.5s linear infinite;
}
```

**Entrance animation:**
- Trigger: Intersection Observer, threshold 0.2
- Nodes fade in from center outward:
  - RAG API (center) appears first: 0ms
  - MCP Server: 150ms
  - Infrastructure nodes: 300ms (staggered 100ms each)
  - Client nodes: 500ms (staggered 100ms each)
- Connection lines draw in (SVG path animation via `stroke-dashoffset` from full length to 0)
  - Duration: 600ms per path, starting after both connected nodes are visible
  - Easing: `cubic-bezier(0.4, 0, 0.2, 1)`

---

### G. Code Block Typing Effect (Hero Terminal)

**Trigger:** Intersection Observer or page load (since hero is visible immediately, trigger on page load with 1000ms delay)

**Behavior:**
- Terminal content is initially empty
- Lines appear one by one, with a typing effect per line
- Speed: 25ms per character for commands, 0ms (instant) for output lines
- Line delay: 300ms between lines
- Cursor: blinking green block `▌`, `color: var(--green-500)`

**Implementation:** Lightweight custom JS or a React `<TypedTerminal>` component. Approximately 40 lines of code. No heavy library needed.

**Reduced motion:** If `prefers-reduced-motion: reduce`, skip typing animation entirely. Show all content immediately.

---

### H. Scroll Progress Indicator

**Trigger:** Scroll event (throttled to requestAnimationFrame)

**Behavior:**
- A 2px bar at `top: 64px` (below nav)
- Width goes from 0% (top of page) to 100% (bottom of page)
- `background: linear-gradient(90deg, var(--blue-500), var(--amber-500))`
- `transform: scaleX(progress); transform-origin: left`
- Opacity: 0 when at very top (within hero), fades in (`transition: opacity 0.3s`) once scrolled past 100vh

**Implementation:** ~15 lines of vanilla JS using `requestAnimationFrame` and `document.documentElement.scrollTop`.

---

### I. CTA Button Micro-interactions

**Primary button (Amber):**
- Hover: `translateY(-1px)` + glow intensifies (shadow expands by 8px)
- Active (mousedown): `translateY(0px)` + glow dims slightly
- Duration: 0.2s for all transitions
- The icon inside shifts 2px right on hover: `transform: translateX(2px)`, `transition: transform 0.2s`

**Secondary button (Ghost):**
- Hover: border brightens, subtle blue background appears
- Active: background intensifies
- The icon does not shift

**GitHub star button (nav):**
- Hover: border brightens, text brightens
- A subtle star icon rotation: `transform: rotate(15deg)`, `transition: transform 0.3s ease`

---

### Global: Reduced Motion Support

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

All Intersection Observer reveal animations should also check `window.matchMedia('(prefers-reduced-motion: reduce)')` and, if true, set elements to their final state immediately.

---

## 4. Content Wireframe (Full Copy)

### Navigation
- Logo: "Reka" (with SVG monogram)
- Links: Features | How It Works | Architecture | Docs | Community
- Badge: [GitHub icon] Star 1.2k
- Button: "Get Started"

### Hero Section

**Badge:** "v1.0 — Now with Memory Governance"

**H1:**
```
Memory that flows.
Knowledge that stays.
```

**Subheadline:**
"Self-hosted RAG infrastructure that gives your AI coding assistants persistent memory, semantic search, and knowledge governance — without sending your code to third parties."

**Primary CTA:** "Deploy in 5 Minutes"
**Secondary CTA:** "View on GitHub"
**Sub-CTA text:** "Free and open source. MIT Licensed."

**Hero terminal content:**
```
$ reka index --project my-app --path ./src
⣾ Indexing 1,247 files across 89 directories...
✓ Parsed 1,247 files (TypeScript, React, CSS)
✓ Extracted 3,891 symbols (functions, classes, types)
✓ Built dependency graph (12,403 edges)
✓ Generated embeddings (2,847 chunks)
✓ Indexed in 34.2s

$ reka recall "How do we handle authentication?"
╭─────────────────────────────────────────────────────╮
│ 3 memories found (2 durable, 1 quarantined)         │
├─────────────────────────────────────────────────────┤
│ ✦ [durable] JWT with refresh tokens via            │
│   AuthMiddleware. Access tokens: 15min,             │
│   refresh: 7 days. See src/middleware/auth.ts       │
│                                                     │
│ ✦ [durable] OAuth2 for third-party integrations.   │
│   Passport.js strategies in src/auth/strategies/    │
│                                                     │
│ ○ [quarantine] Consider switching to session-based  │
│   auth for admin panel (unverified, confidence: 0.6)│
╰─────────────────────────────────────────────────────┘
```

Terminal alt text: "Terminal showing Reka indexing a codebase of 1,247 files in 34 seconds, then recalling authentication-related memories with governance status indicators."

### Problem Statement (Section 3)

**Label:** THE PROBLEM
**H2:** "Your AI assistant forgets everything. Every. Single. Time."

**Card 1:**
- Icon: brain-cog (red)
- **H3:** "Groundhog Day Debugging"
- Body: "You explain the same architectural decisions to your AI assistant every session. It re-discovers patterns you settled months ago. Context windows reset, and so does all the knowledge."

**Card 2:**
- Icon: search-x (yellow)
- **H3:** "Codebase Blindness"
- Body: "Your assistant generates code that ignores existing patterns, duplicates utilities already built, and contradicts architectural decisions documented three directories away. It cannot see the forest for the trees."

**Card 3:**
- Icon: cloud-off (blue)
- **H3:** "Vendor Lock-in & Data Leakage"
- Body: "Cloud-hosted memory solutions mean your proprietary code, architectural decisions, and internal documentation flow through third-party servers. Compliance teams are not amused. Neither are you."

### How It Works (Section 4)

**Label:** HOW IT WORKS
**H2:** "From zero to persistent memory in four steps"

**Step 1 — Deploy:**
"One `docker-compose up` command. Qdrant, embeddings, and the API spin up in under 60 seconds. No cloud account needed."

**Step 2 — Connect:**
"Point your AI assistant to Reka via MCP. Works with Claude Code, Cursor, Windsurf, or any MCP-compatible client. One JSON config."

**Step 3 — Index:**
"Reka crawls your codebase, extracts symbols, builds a dependency graph, and creates semantic embeddings. Incremental re-indexing keeps it fresh."

**Step 4 — Remember:**
"Your assistant now has persistent memory. Decisions carry forward. Patterns are recognized. Context survives across sessions, across days, across teammates."

### Features Grid (Section 5)

**Label:** FEATURES
**H2:** "Everything your AI assistant needs to truly understand your codebase"

**Card 1 — Semantic Code Search:**
"Hybrid search combining vector similarity and keyword matching. Find code by describing what it does, not just what it is named. BM25 + dense embeddings with reciprocal rank fusion."
Badge: `hybrid_search("retry logic with backoff")`

**Card 2 — Dependency Graph:**
"Automatically maps imports, extends, and implements relationships across your codebase. Trace blast radius before refactoring. N-hop expansion reveals hidden coupling."

**Card 3 — Memory Governance:**
"Not all memories are equal. Auto-generated memories enter quarantine. Human-verified knowledge becomes durable. Contradictions are detected and resolved. Your knowledge base stays clean."
Badge: USP

**Card 4 — Symbol Index:**
"Instant lookup of functions, classes, types, and interfaces by name. Faster than grep, smarter than tree-sitter alone. Supports TypeScript, Python, Go, Rust, Java, and more."

**Card 5 — MCP Native:**
"Built from the ground up for the Model Context Protocol. 35 tools that integrate natively with Claude Code, Cursor, Windsurf, and any MCP-compatible client. No adapters, no shims."

**Card 6 — Multi-Project Isolation:**
"One infrastructure, unlimited projects. Each project gets namespaced vector collections, isolated memory stores, and independent dependency graphs. Share the server, never the data."

### Memory Governance (Section 6)

**Label:** MEMORY GOVERNANCE
**H2:** "Not all knowledge deserves permanence"
**Intro:** "AI assistants generate memories constantly — but hallucinated patterns and stale decisions pollute your knowledge base over time. Reka introduces a governance layer inspired by how human memory actually works."

**Stage 1 — Quarantine:**
Status pill: "Auto-generated"
"Every auto-generated memory starts here. Marked with a confidence score and source attribution. Quarantined memories are available for recall but flagged as unverified."

**Stage 2 — Review:**
Status pill: "Pending validation"
"Contradiction detection automatically flags memories that conflict with existing knowledge. Stale memories past their TTL surface for re-evaluation. Duplicates are merged."

**Stage 3 — Durable:**
Status pill: "Human-verified"
"Manually created memories and reviewed auto-memories graduate to durable status. These form your project's canonical knowledge base — architectural decisions, established patterns, verified insights."

**Visual card content (front card):**
```
type: "pattern"
status: "durable"
content: "Use repository pattern for all
           database access. Direct Qdrant
           client calls only in vector-store.ts"
confidence: 0.94
source: "human"
created: "2025-01-15"
```

### Architecture (Section 7)

**Label:** ARCHITECTURE
**H2:** "Transparent by design. No black boxes."

**Node tooltip content:**
- Claude Code: "Native MCP client. Connects via stdio transport."
- Cursor: "MCP support via extension. HTTP transport."
- Any MCP Client: "Any client implementing the MCP specification."
- MCP Server: "35 tools. Project isolation via X-Project-Name header. TypeScript."
- RAG API: "Express.js on port 3100. Routes: /api/search, /api/memory, /api/index, /api/ask"
- Qdrant: "Vector database. REST :6333, gRPC :6334. Per-project collections."
- Ollama: "Local LLM inference. Default: qwen3:8b. Used for routing, reranking, summaries."
- BGE-M3: "Embedding model. 1024-dimensional dense vectors. Runs on CPU or GPU."
- Redis: "Session cache, rate limiting, temporary state. Port 6380."

### Comparison (Section 8)

**Label:** COMPARISON
**H2:** "How Reka compares"

(Table content specified in Section 8 layout above.)

### Quick Start (Section 9)

**Label:** QUICK START
**H2:** "Up and running in three commands"

(Terminal content specified in Section 9 layout above.)

**Requirement badges:** "Docker 24+", "8GB RAM", "Node 18+", "~2GB disk"

### Open Source (Section 10)

**Label:** OPEN SOURCE
**H2:** "Built in the open. Shaped by developers."
**Body:** "Reka is MIT licensed and always will be. No open-core bait-and-switch. No enterprise edition hiding the good parts. Every feature, every line of code, available to everyone."

**Stats:** 35+ MCP Tools | 12k GitHub Stars | 150+ Contributors | MIT License

**Card 1 — Contribute:**
"Pick up a good-first-issue, improve docs, or add a new parser. Every PR gets a thoughtful review within 48 hours."
Link: "View open issues →"

**Card 2 — Discuss:**
"Join the conversation on GitHub Discussions. Share your setup, request features, or help other developers get started."
Link: "Join discussions →"

**Card 3 — Stay Updated:**
"Star the repo to get release notifications. We ship updates every two weeks with a detailed changelog."
Link: "Star on GitHub →"

### Footer

**Brand tagline:** "Memory that flows. Knowledge that stays."

**Product column:** Features, Architecture, Documentation, Changelog, Roadmap
**Developers column:** Quick Start, API Reference, MCP Integration, Self-Hosting Guide, Contributing
**Community column:** GitHub Discussions, Discord Server, Twitter, Blog, Release Notes

**Copyright:** "© 2025 Reka Contributors. MIT License."
**Legal links:** Privacy Policy · Terms

---

## 5. Responsive Breakpoints (Summary Matrix)

| Element | Desktop (1440+) | Laptop (1024-1439) | Tablet (768-1023) | Mobile (320-767) |
|---------|-----------------|--------------------|--------------------|-------------------|
| **Container max** | 1200px | 1200px | 100% - 80px pad | 100% - 48px pad |
| **Nav links** | Visible | Visible | Hamburger menu | Hamburger menu |
| **Nav GitHub badge** | Visible | Visible | Visible | Hidden |
| **Hero H1** | 72px | 60px | 48px | 36px |
| **Hero terminal** | 1000px max | 900px max | 100% width | 100%, 12px radius |
| **Pain point grid** | 3 columns | 3 columns | 1 column | 1 column |
| **How-it-works** | 4 columns + line | 4 columns + line | 2x2 grid, no line | 1 column, inline layout |
| **Features grid** | 3x2 | 3x2, 20px gap | 2 columns | 1 column |
| **Memory governance** | 2-col split | 2-col split | 1 column (visual first) | 1 column, simplified visual |
| **Architecture** | Full diagram | Scaled diagram | Scaled, no labels | Vertical stack |
| **Comparison table** | Full width | Full width | Horizontal scroll, sticky col 1 | Horizontal scroll |
| **Quick start terminal** | 700px centered | 700px centered | Full width | Full width, smaller font |
| **Community grid** | 3 columns | 3 columns | 1 column | 1 column |
| **Footer** | 4 columns | 4 columns | 2x2 | 1 column |
| **Section H2** | 56px | 48px | 40px | 32px |
| **Section padding** | 120px vertical | 100px vertical | 80px vertical | 64px vertical |

---

## 6. Technical Implementation Notes

### Framework

**Recommended: Astro 5.x with React islands**

- Astro for static shell (nav, footer, content sections) — zero JS by default
- React islands (`client:visible`) for interactive components:
  - `<TypedTerminal />` — hero typing effect
  - `<ArchitectureDiagram />` — hover tooltips, animated connections
  - `<ScrollProgress />` — progress bar
  - `<MobileNav />` — hamburger menu
  - `<CopyButton />` — clipboard interaction
- Total JS budget: < 40KB gzipped

### CSS Approach

**Tailwind CSS v4**

- Use `@theme` in `global.css` to define all design tokens listed in Section 0
- Use Tailwind utility classes for layout, spacing, typography
- Custom CSS for:
  - Keyframe animations (`@keyframes fadeInUp`, `flowDot`, `float`, `dashFlow`, `blink`)
  - Glassmorphism (backdrop-filter)
  - Custom scrollbar styling
  - SVG path animations (stroke-dashoffset)
- Use `@apply` sparingly — prefer utilities in markup

### Font Loading

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" media="print" onload="this.media='all'">
```

Alternative: Self-host fonts in `/public/fonts/` with `@font-face` declarations for better performance and privacy. Subset to Latin characters only.

### Image Formats

| Asset Type | Format | Notes |
|------------|--------|-------|
| Logo / icons | SVG | Inline where possible for styling control |
| Hero terminal | HTML/CSS | Not an image — built with code |
| Architecture diagram | HTML/CSS/SVG | Interactive, not raster |
| OG image | PNG 1200x630 | Pre-generated, served from `/public/og/` |
| Favicon | SVG + PNG fallback | 32x32 PNG, plus SVG for modern browsers |

No raster images on the page. Everything is vector, HTML, or CSS.

### Performance Targets

| Metric | Target | Strategy |
|--------|--------|----------|
| LCP | < 1.2s | Hero text is static HTML, no layout shift, fonts preloaded |
| CLS | < 0.05 | All elements have explicit dimensions, font-display: swap with matched fallback |
| INP | < 100ms | Minimal JS, no heavy frameworks, event handlers are passive |
| Total page weight | < 200KB (gzipped) | No images, minimal JS, Tailwind purge |
| Time to Interactive | < 2s | Astro static HTML, React islands load on visibility |

### SEO

**Meta tags:**
```html
<title>Reka — Self-Hosted RAG Infrastructure for AI Coding Assistants</title>
<meta name="description" content="Give your AI coding assistants persistent memory, semantic code search, and knowledge governance. Self-hosted, open source, MCP native. Deploy in 5 minutes.">
<meta name="keywords" content="RAG, MCP, AI coding assistant, memory governance, self-hosted, vector search, code search, developer tools">
<link rel="canonical" href="https://reka.dev/">
```

**Open Graph:**
```html
<meta property="og:title" content="Reka — Memory that flows. Knowledge that stays.">
<meta property="og:description" content="Self-hosted RAG infrastructure for AI coding assistants with persistent memory and knowledge governance.">
<meta property="og:image" content="https://reka.dev/og/landing.png">
<meta property="og:url" content="https://reka.dev/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Reka">
```

**Twitter Card:**
```html
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Reka — Memory that flows. Knowledge that stays.">
<meta name="twitter:description" content="Self-hosted RAG infrastructure for AI coding assistants.">
<meta name="twitter:image" content="https://reka.dev/og/landing.png">
```

**Structured Data (JSON-LD):**
```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Reka",
  "description": "Self-hosted RAG infrastructure for AI coding assistants with memory governance",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Linux, macOS, Windows (Docker)",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "license": "https://opensource.org/licenses/MIT",
  "url": "https://reka.dev",
  "codeRepository": "https://github.com/reka-ai/reka"
}
```

### Analytics Integration Points

Place analytics event triggers at these locations:
1. Page load (standard pageview)
2. CTA click: "Deploy in 5 Minutes" — `event: cta_click, label: deploy_hero`
3. CTA click: "View on GitHub" — `event: cta_click, label: github_hero`
4. CTA click: "Get Started" (nav) — `event: cta_click, label: get_started_nav`
5. Section visibility (each section entering viewport) — `event: section_view, label: [section_name]`
6. Copy button click (quick start terminal) — `event: copy_code, label: quickstart`
7. Outbound link clicks (GitHub, Discord, etc.) — `event: outbound_click, label: [destination]`
8. Scroll depth milestones: 25%, 50%, 75%, 100% — `event: scroll_depth, value: [percent]`

Use privacy-respecting analytics: Plausible, Fathom, or Umami (self-hosted). No Google Analytics.

---

## 7. Asset List

| # | Asset | Type | Dimensions/Size | Placement | Source |
|---|-------|------|------------------|-----------|--------|
| 1 | Reka logo monogram | SVG | 28px height (nav), 24px (footer) | Nav, Footer | Custom design — abstract river/flow mark |
| 2 | Reka wordmark | SVG or text | Rendered via Inter 700 | Nav, Footer | Text in Inter Bold |
| 3 | Lucide `sparkles` | SVG icon | 14px | Hero version badge | Lucide icons |
| 4 | Lucide `rocket` | SVG icon | 18px | Hero primary CTA | Lucide icons |
| 5 | Lucide `github` | SVG icon | 18px (CTA), 16px (nav badge), 20px (footer) | Nav, Hero CTA, Footer | Lucide icons |
| 6 | Lucide `brain-cog` | SVG icon | 24px | Pain point card 1 | Lucide icons |
| 7 | Lucide `search-x` | SVG icon | 24px | Pain point card 2 | Lucide icons |
| 8 | Lucide `cloud-off` | SVG icon | 24px | Pain point card 3 | Lucide icons |
| 9 | Lucide `search-code` | SVG icon | 24px | Feature card 1 | Lucide icons |
| 10 | Lucide `git-graph` | SVG icon | 24px | Feature card 2 | Lucide icons |
| 11 | Lucide `shield-check` | SVG icon | 24px | Feature card 3 | Lucide icons |
| 12 | Lucide `braces` | SVG icon | 24px | Feature card 4 | Lucide icons |
| 13 | Lucide `plug-zap` | SVG icon | 24px | Feature card 5 | Lucide icons |
| 14 | Lucide `layers` | SVG icon | 24px | Feature card 6 | Lucide icons |
| 15 | Lucide `check` | SVG icon | 16px | Comparison table checkmarks | Lucide icons |
| 16 | Lucide `x` | SVG icon | 16px | Comparison table crosses | Lucide icons |
| 17 | Lucide `minus` | SVG icon | 16px | Comparison table partial | Lucide icons |
| 18 | Lucide `copy` | SVG icon | 16px | Quick start copy button | Lucide icons |
| 19 | Lucide `check` | SVG icon | 16px | Copy button success state | Lucide icons |
| 20 | Lucide `git-pull-request` | SVG icon | 24px | Community card 1 | Lucide icons |
| 21 | Lucide `message-circle` | SVG icon | 24px | Community card 2 | Lucide icons |
| 22 | Lucide `bell-ring` | SVG icon | 24px | Community card 3 | Lucide icons |
| 23 | Lucide `terminal` | SVG icon | 24px | Architecture: Claude Code node | Lucide icons |
| 24 | Lucide `mouse-pointer` | SVG icon | 24px | Architecture: Cursor node | Lucide icons |
| 25 | Lucide `plug` | SVG icon | 24px | Architecture: Any MCP Client node | Lucide icons |
| 26 | Lucide `database` | SVG icon | 24px | Architecture: Qdrant node | Lucide icons |
| 27 | Lucide `brain` | SVG icon | 24px | Architecture: Ollama node | Lucide icons |
| 28 | Lucide `cpu` | SVG icon | 24px | Architecture: BGE-M3 node | Lucide icons |
| 29 | Lucide `hard-drive` | SVG icon | 24px | Architecture: Redis node | Lucide icons |
| 30 | Lucide `menu` | SVG icon | 24px | Mobile hamburger menu | Lucide icons |
| 31 | Lucide `x` | SVG icon | 24px | Mobile menu close | Lucide icons |
| 32 | Discord icon | SVG icon | 20px | Footer social | Simple Icons or custom |
| 33 | Twitter/X icon | SVG icon | 20px | Footer social | Simple Icons or custom |
| 34 | OG image | PNG | 1200x630px | `<meta>` tags only | Custom — dark bg, Reka logo, tagline, terminal preview |
| 35 | Favicon | SVG + 32x32 PNG | 32x32 | `<link rel="icon">` | Reka monogram, blue on transparent |
| 36 | Apple touch icon | PNG | 180x180 | `<link rel="apple-touch-icon">` | Reka monogram on dark bg |
| 37 | Dot grid background pattern | CSS | Repeating 32px | `<body>` background | CSS `radial-gradient` pattern, not an asset file |
| 38 | Blueprint grid pattern | CSS | Repeating 40px | Architecture section bg | CSS `linear-gradient`, not an asset file |

**Total external assets:** 2 font families (Google Fonts or self-hosted), ~30 Lucide SVG icons (tree-shaken, ~15KB total), 3 raster images (OG, favicon, apple-touch only). All other visuals are CSS or inline SVG.

---

This specification covers every section, component, animation, content block, responsive behavior, and technical requirement for the Reka landing page. A designer can produce pixel-perfect mockups from the color tokens, spacing scales, and typography definitions. A developer can implement without ambiguity using the CSS snippets, animation keyframes, breakpoint matrix, and component specifications provided.
