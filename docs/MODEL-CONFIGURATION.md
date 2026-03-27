Now I have a thorough understanding of the existing architecture. Let me produce the complete design.

---

# Reka Model Configuration System -- Complete Design

---

## 1. Model Configuration File (`reka.config.yaml`)

### Full Schema

```yaml
# reka.config.yaml — Model configuration for Reka RAG infrastructure
# Place in project root or ~/.config/reka/config.yaml (global fallback)
# Env var overrides: REKA_CONFIG=/path/to/config.yaml

# ─────────────────────────────────────────────
# Models: which AI handles what
# ─────────────────────────────────────────────
models:
  embeddings:
    provider: bge-m3          # bge-m3 | ollama | openai | azure-openai | custom
    model: BAAI/bge-m3        # Model identifier (provider-specific)
    dimensions: 1024          # Output vector size. Must match Qdrant collections.
    url: http://localhost:8080 # Endpoint (bge-m3/ollama/custom only)
    api_key: null             # Required for openai/azure-openai
    batch_size: 100           # Max texts per batch request
    sparse_vectors: true      # Enable sparse vectors (bge-m3 only, hybrid search)
    timeout_ms: 15000         # Per-request timeout

  llm:
    # Utility: cheap/fast tasks (query rewriting, reranking, routing, memory merge)
    utility:
      provider: ollama        # ollama | openai | anthropic | azure-openai | custom
      model: qwen3.5:35b
      url: http://localhost:11434
      temperature: 0.3        # Low creativity for deterministic tasks
      max_tokens: 2048
      thinking: false         # No reasoning traces for utility
      json_mode: true         # Most utility tasks produce JSON
      timeout_ms: 120000
      context_window: 4096    # num_ctx for Ollama

    # Standard: default tier for general tasks (code search QA, memory governance)
    standard:
      provider: ollama
      model: qwen3.5:35b
      url: http://localhost:11434
      temperature: 0.7
      max_tokens: 4096
      thinking: true
      timeout_ms: 180000
      context_window: 4096

    # Complex: expensive/smart tasks (agents, PR review, architecture analysis)
    complex:
      provider: anthropic
      model: claude-sonnet-4-6
      api_key: ${ANTHROPIC_API_KEY}   # Env var interpolation
      temperature: 0.7
      max_tokens: 8192
      thinking: true
      thinking_budget: 16384  # Max tokens for thinking trace
      effort: high            # low | medium | high | max (Anthropic only)
      timeout_ms: 180000

  # ─────────────────────────────────────────────
  # Routing: which tasks go to which tier
  # ─────────────────────────────────────────────
  routing:
    # Default task-to-tier mapping (overridable per-project)
    tasks:
      query_rewrite:       utility
      search_rerank:       utility
      memory_merge:        utility
      memory_dedup:        utility
      entity_extraction:   utility
      routing_decision:    utility
      tag_generation:      utility

      code_explanation:    standard
      memory_governance:   standard
      conversation_analysis: standard
      pattern_extraction:  standard

      agent_reasoning:     complex
      pr_review:           complex
      architecture_analysis: complex
      tribunal_judge:      complex
      tribunal_advocate:   complex
      code_generation:     complex
      deep_research:       complex

    # Override routing for specific callers
    overrides:
      # Example: force memory governance to complex for this project
      # memory_governance: complex

    # A/B testing: route X% of traffic to an alternative tier
    experiments: []
      # - task: code_explanation
      #   variant_tier: complex
      #   traffic_pct: 10        # 10% of code_explanation goes to complex
      #   tracking_id: exp-001   # Logged with usage data for comparison

  # ─────────────────────────────────────────────
  # Fallback: what happens when primary fails
  # ─────────────────────────────────────────────
  fallback:
    # Ordered chains per provider. Tries left-to-right.
    chains:
      ollama:    [ollama, anthropic, openai]
      anthropic: [anthropic, ollama]
      openai:    [openai, anthropic, ollama]

    # Retry settings per attempt in the chain
    retry:
      max_attempts: 2
      base_delay_ms: 1000
      max_delay_ms: 15000

    # Circuit breaker: stop trying a provider after repeated failures
    circuit_breaker:
      failure_threshold: 5    # Failures before opening circuit
      success_threshold: 2    # Successes to close circuit
      timeout_ms: 30000       # Time in OPEN before retrying

  # ─────────────────────────────────────────────
  # Budgets: cost and token limits
  # ─────────────────────────────────────────────
  budgets:
    # Hard limits — requests are rejected when exceeded
    daily_usd: 10.00          # null = unlimited
    monthly_usd: 200.00
    daily_tokens: 5000000     # 5M tokens/day

    # Soft limits — log warnings, send alerts, but do not reject
    warn_daily_usd: 7.00
    warn_monthly_usd: 150.00

    # Per-task-type token caps (prevent runaway single requests)
    per_request:
      utility:  4096
      standard: 8192
      complex:  32768

    # Cost alerts
    alerts:
      enabled: true
      channels: [log]         # log | email | webhook
      webhook_url: null
      email: null

  # ─────────────────────────────────────────────
  # Pricing: cost per 1M tokens (USD)
  # ─────────────────────────────────────────────
  pricing:
    claude-sonnet-4-6:   { input: 3.00,  output: 15.00 }
    claude-opus-4-6:     { input: 15.00, output: 75.00 }
    claude-haiku-4-5:    { input: 0.80,  output: 4.00  }
    gpt-4-turbo-preview: { input: 10.00, output: 30.00 }
    gpt-4o:              { input: 2.50,  output: 10.00 }
    gpt-4o-mini:         { input: 0.15,  output: 0.60  }
    ollama:              { input: 0,     output: 0     }
    # Custom entries auto-merged:
    # my-finetuned-model: { input: 1.00, output: 5.00 }
```

### Five Example Configs

#### a) Zero Config -- Reka Cloud

```yaml
# reka.config.yaml — Reka Cloud (subscription handles everything)
cloud:
  enabled: true
  api_key: ${REKA_CLOUD_API_KEY}
  plan: pro                   # free | pro | enterprise
  region: us-east-1

# Everything auto-configured by cloud. Local overrides optional.
# Embeddings: Reka-hosted BGE-M3
# Utility LLM: Reka-hosted small model
# Complex LLM: Claude Sonnet via Reka proxy
```

#### b) Privacy Max -- Everything Local

```yaml
# reka.config.yaml — Full local deployment, no data leaves your network
models:
  embeddings:
    provider: ollama
    model: bge-m3
    dimensions: 1024
    url: http://localhost:11434

  llm:
    utility:
      provider: ollama
      model: qwen3:8b          # Small model for cheap tasks
      url: http://localhost:11434
      temperature: 0.3
      thinking: false
      context_window: 4096

    standard:
      provider: ollama
      model: qwen3.5:35b
      url: http://localhost:11434
      thinking: true

    complex:
      provider: ollama
      model: qwen3.5:35b       # Same model, more tokens + thinking
      url: http://localhost:11434
      thinking: true
      max_tokens: 16384
      context_window: 8192

  fallback:
    chains:
      ollama: [ollama]         # No cloud fallback — privacy first

  budgets:
    daily_usd: 0               # Everything is free (local)
```

#### c) Cost Optimized -- Local Embeddings + Cloud LLM for Complex Only

```yaml
# reka.config.yaml — Minimize cloud spend, local where possible
models:
  embeddings:
    provider: bge-m3
    model: BAAI/bge-m3
    dimensions: 1024
    url: http://localhost:8080
    sparse_vectors: true

  llm:
    utility:
      provider: ollama
      model: qwen3:8b
      url: http://localhost:11434
      thinking: false

    standard:
      provider: ollama
      model: qwen3.5:35b
      url: http://localhost:11434
      thinking: true

    complex:
      provider: anthropic
      model: claude-haiku-4-5   # Haiku, not Sonnet — 4x cheaper
      api_key: ${ANTHROPIC_API_KEY}
      thinking: true
      effort: medium

  routing:
    overrides:
      # Downgrade some "complex" tasks to standard (local)
      architecture_analysis: standard
      code_generation: standard

  budgets:
    daily_usd: 2.00
    monthly_usd: 40.00
    warn_daily_usd: 1.50
    alerts:
      enabled: true
      channels: [log, webhook]
      webhook_url: https://hooks.slack.com/services/T.../B.../xxx
```

#### d) Enterprise -- Azure OpenAI + Custom Embedding Endpoint

```yaml
# reka.config.yaml — Enterprise with Azure OpenAI and corporate proxy
models:
  embeddings:
    provider: custom
    model: text-embedding-3-large
    dimensions: 3072
    url: https://myorg.openai.azure.com/openai/deployments/embed-large/embeddings
    api_key: ${AZURE_OPENAI_KEY}
    batch_size: 50
    headers:
      api-version: "2024-06-01"

  llm:
    utility:
      provider: azure-openai
      model: gpt-4o-mini
      url: https://myorg.openai.azure.com/openai/deployments/gpt4o-mini/chat/completions
      api_key: ${AZURE_OPENAI_KEY}
      headers:
        api-version: "2024-06-01"
      temperature: 0.3
      thinking: false

    standard:
      provider: azure-openai
      model: gpt-4o
      url: https://myorg.openai.azure.com/openai/deployments/gpt4o/chat/completions
      api_key: ${AZURE_OPENAI_KEY}
      headers:
        api-version: "2024-06-01"

    complex:
      provider: azure-openai
      model: gpt-4o
      url: https://myorg.openai.azure.com/openai/deployments/gpt4o/chat/completions
      api_key: ${AZURE_OPENAI_KEY}
      headers:
        api-version: "2024-06-01"
      max_tokens: 16384

  fallback:
    chains:
      azure-openai: [azure-openai]   # No external fallback — compliance

  budgets:
    monthly_usd: 5000.00
    alerts:
      enabled: true
      channels: [email, webhook]
      email: platform-team@myorg.com
      webhook_url: https://myorg.pagerduty.com/webhooks/xxx

  pricing:
    gpt-4o:      { input: 2.50, output: 10.00 }
    gpt-4o-mini: { input: 0.15, output: 0.60  }
    text-embedding-3-large: { input: 0.13, output: 0 }
```

#### e) Research -- Multiple Models for A/B Testing

```yaml
# reka.config.yaml — Research setup with experiments
models:
  embeddings:
    provider: bge-m3
    model: BAAI/bge-m3
    dimensions: 1024
    url: http://localhost:8080

  llm:
    utility:
      provider: ollama
      model: qwen3:8b
      url: http://localhost:11434
      thinking: false

    standard:
      provider: anthropic
      model: claude-sonnet-4-6
      api_key: ${ANTHROPIC_API_KEY}
      thinking: true

    complex:
      provider: anthropic
      model: claude-opus-4-6
      api_key: ${ANTHROPIC_API_KEY}
      thinking: true
      effort: max
      max_tokens: 32768

  routing:
    experiments:
      - task: code_explanation
        variant_tier: complex
        traffic_pct: 25
        tracking_id: exp-sonnet-vs-opus-explain
        
      - task: pr_review
        variant_tier: standard
        traffic_pct: 50
        tracking_id: exp-sonnet-review-quality
        
      - task: memory_governance
        variant_tier: utility
        traffic_pct: 30
        tracking_id: exp-governance-cheapmodel

    # Additional models available for manual testing (not routed automatically)
    test_pool:
      - provider: openai
        model: gpt-4o
        api_key: ${OPENAI_API_KEY}
        label: "GPT-4o baseline"
      - provider: ollama
        model: llama3.3:70b
        url: http://gpu-server:11434
        label: "Llama 3.3 70B"

  budgets:
    daily_usd: 50.00          # Research budgets are higher
    monthly_usd: 1000.00
```

---

## 2. Dashboard Model Settings UI

### Overall Layout

The settings page lives at `/settings/models` in the Vue 3 dashboard. It uses PrimeVue 4 Tabs with four TabPanels. The page header shows a status bar: three colored dots (green/yellow/red) for embeddings, utility LLM, complex LLM health.

### Section A: Active Models

**Layout:** Three horizontal cards in a row (flex, wrapping on mobile). Each card is a PrimeVue Card component.

```
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│  EMBEDDINGS             │ │  LLM (Utility)          │ │  LLM (Complex)          │
│  ─────────────────────  │ │  ─────────────────────  │ │  ─────────────────────  │
│  Provider: BGE-M3       │ │  Provider: Ollama       │ │  Provider: Anthropic    │
│  Model: BAAI/bge-m3     │ │  Model: qwen3.5:35b     │ │  Model: claude-sonnet.. │
│  Dimensions: 1024       │ │  Thinking: off          │ │  Thinking: on (high)    │
│                         │ │                         │ │                         │
│  Status: [*] Healthy    │ │  Status: [*] Healthy    │ │  Status: [*] Healthy    │
│  Avg latency: 45ms      │ │  Avg latency: 1.2s      │ │  Avg latency: 3.4s      │
│  Cost/1K tok: $0.00     │ │  Cost/1K tok: $0.00     │ │  Cost/1K tok: $0.009    │
│                         │ │                         │ │                         │
│  [v] Switch provider    │ │  [v] Switch provider    │ │  [v] Switch provider    │
│  [Test Connection]      │ │  [Test Connection]      │ │  [Test Connection]      │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
```

**Components per card:**
- **Header:** Role name + colored status indicator (Tag component: `severity="success"` / `"warning"` / `"danger"`)
- **Body:** Key-value pairs using a description list. Provider, model, dimensions (embeddings only), thinking mode, context window.
- **Metrics row:** Three inline Chip components showing latency, cost, status. Data from `/api/analytics/cost-summary` and circuit breaker state.
- **Quick-switch:** PrimeVue Dropdown bound to available providers. Changing triggers a confirmation Dialog ("Switching complex LLM to OpenAI. This takes effect immediately. Continue?").
- **Test button:** PrimeVue Button (`severity="secondary"`). On click, sends a test prompt to the provider, shows result in a Toast with latency.

### Section B: Provider Configuration

**Layout:** PrimeVue Accordion with one AccordionTab per provider. Each tab contains a form.

```
[v] Ollama                                    [Connected - 23ms]
    ┌─────────────────────────────────────────────────────────┐
    │  API URL:     [ http://localhost:11434        ]         │
    │  Model:       [ qwen3.5:35b               v  ]  [Refresh Models]
    │  Temperature: [====O========] 0.7                       │
    │  Max Tokens:  [ 2048     ]                              │
    │  Context Win: [ 4096     ]                              │
    │  Thinking:    [x] Enable    Budget: [ 8192 ]            │
    │                                                         │
    │  Available models (auto-discovered):                    │
    │  ┌──────────────┬──────────┬──────────┬────────────┐   │
    │  │ Model        │ Size     │ Quant    │ Modified   │   │
    │  ├──────────────┼──────────┼──────────┼────────────┤   │
    │  │ qwen3.5:35b  │ 21 GB   │ Q4_K_M   │ 2 days ago │   │
    │  │ qwen3:8b     │ 4.9 GB  │ Q4_K_M   │ 5 days ago │   │
    │  │ llama3.3:70b │ 42 GB   │ Q4_K_M   │ 1 week ago │   │
    │  └──────────────┴──────────┴──────────┴────────────┘   │
    │                                                         │
    │  [Test Connection]  Latency: 23ms  Status: Connected    │
    └─────────────────────────────────────────────────────────┘

[>] OpenAI                                    [Not configured]

[>] Anthropic                                 [Connected - 890ms]
    ┌─────────────────────────────────────────────────────────┐
    │  API Key:     [ sk-ant-...•••••••••••  ] [Show/Hide]   │
    │  Model:       [ claude-sonnet-4-6      v ]              │
    │  Temperature: [====O========] 0.7                       │
    │  Max Tokens:  [ 8192     ]                              │
    │  Thinking:    [x] Enable                                │
    │  Effort:      ( ) Low  ( ) Medium  (*) High  ( ) Max    │
    │  Think Budget:[ 16384    ]                              │
    │                                                         │
    │  Est. cost:   $3.00/1M input  |  $15.00/1M output       │
    │  [Test Connection]  Latency: 890ms  Status: Connected   │
    └─────────────────────────────────────────────────────────┘

[>] Custom Endpoint                           [Not configured]
    ┌─────────────────────────────────────────────────────────┐
    │  Label:       [ My fine-tuned model     ]               │
    │  Type:        (*) LLM  ( ) Embeddings                   │
    │  API URL:     [ https://my-model.example.com/v1/chat ]  │
    │  API Key:     [ •••••••••••             ] [Show/Hide]   │
    │  API Format:  (*) OpenAI-compatible  ( ) Custom         │
    │  Headers:     [+ Add Header]                            │
    │    api-version: [ 2024-06-01 ]  [x]                     │
    │  Model name:  [ my-model-v2             ]               │
    │  Dimensions:  [ 1536     ] (embeddings only)            │
    │                                                         │
    │  [Test Connection]                                      │
    └─────────────────────────────────────────────────────────┘
```

**Key interactions:**
- API keys use InputText with `type="password"` and a toggle Button to show/hide.
- Model selection Dropdown is populated by auto-discovery (Ollama) or a hardcoded list (OpenAI/Anthropic). "Refresh Models" button re-queries `GET /api/tags`.
- Temperature uses a PrimeVue Slider (min=0, max=2, step=0.1) with a numeric InputNumber beside it.
- Connection test sends a small prompt ("Say hello in 3 words"), displays latency in a Tag and response text in a small readonly textarea.

### Section C: Routing Rules

**Layout:** Two sub-sections. Top: task mapping table. Bottom: fallback chain visualizer.

```
Task Routing
┌─────────────────────────┬──────────────┬──────────────────────┐
│ Task                    │ Default Tier │ Override             │
├─────────────────────────┼──────────────┼──────────────────────┤
│ query_rewrite           │ utility      │ [ — (use default) v] │
│ search_rerank           │ utility      │ [ — (use default) v] │
│ memory_merge            │ utility      │ [ — (use default) v] │
│ code_explanation        │ standard     │ [ complex         v] │
│ agent_reasoning         │ complex      │ [ — (use default) v] │
│ pr_review               │ complex      │ [ — (use default) v] │
│ architecture_analysis   │ complex      │ [ — (use default) v] │
│ memory_governance       │ standard     │ [ — (use default) v] │
└─────────────────────────┴──────────────┴──────────────────────┘

Fallback Chains                                    [+ Add Chain]
┌──────────────────────────────────────────────────────────────┐
│  Ollama fails →                                              │
│  ┌────────┐    ┌───────────┐    ┌────────┐                  │
│  │ Ollama │ -> │ Anthropic │ -> │ OpenAI │                  │
│  └────────┘    └───────────┘    └────────┘                  │
│                                                              │
│  Anthropic fails →                                           │
│  ┌───────────┐    ┌────────┐                                │
│  │ Anthropic │ -> │ Ollama │                                │
│  └───────────┘    └────────┘                                │
│                                                              │
│  OpenAI fails →                                              │
│  ┌────────┐    ┌───────────┐    ┌────────┐                  │
│  │ OpenAI │ -> │ Anthropic │ -> │ Ollama │                  │
│  └────────┘    └───────────┘    └────────┘                  │
└──────────────────────────────────────────────────────────────┘

Token Budget per Request
┌────────────┬────────────────────────────────────────┬───────┐
│ Tier       │ Slider                                 │ Value │
├────────────┼────────────────────────────────────────┼───────┤
│ utility    │ [==O===========================]       │ 4096  │
│ standard   │ [========O=====================]       │ 8192  │
│ complex    │ [======================O=======]       │ 32768 │
└────────────┴────────────────────────────────────────┴───────┘
```

The fallback chain uses a visual pipeline rendered with simple div boxes and arrow connectors. Each box is draggable (HTML5 drag-and-drop or `vuedraggable`) to reorder. Override column uses a Dropdown with options: `[-- use default --, utility, standard, complex]`.

### Section D: Usage & Costs

**Layout:** Full-width dashboard section with four sub-panels.

```
┌─ Token Consumption (last 7 days) ─────────────────────────────────────┐
│                                                                        │
│  [vue-echarts stacked area chart]                                      │
│  X-axis: date, Y-axis: tokens                                         │
│  Series: Ollama (blue), Anthropic (orange), OpenAI (green)            │
│  Period selector: [Today] [7d] [30d] [Custom]                         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Cost Breakdown ──────────────────┐ ┌─ Budget Status ────────────────┐
│                                    │ │                                │
│  Today:      $1.23                 │ │  Daily:   [=======O--] $7/$10  │
│  This week:  $8.45                 │ │  Monthly: [====O------] $45/$200│
│  This month: $34.12               │ │                                │
│                                    │ │  [!] Warning at $7/day         │
│  By provider:                      │ │  [x] Hard limit at $10/day     │
│    Ollama:    $0.00 (1.2M tokens) │ │                                │
│    Anthropic: $31.50 (890K tokens)│ │  [Configure Alerts]            │
│    OpenAI:    $2.62 (120K tokens) │ │                                │
│                                    │ │                                │
│  By task type:                     │ │                                │
│    agent_reasoning: $18.40         │ │                                │
│    pr_review:       $8.20          │ │                                │
│    code_explanation: $4.90         │ │                                │
│    utility tasks:    $2.62         │ │                                │
└────────────────────────────────────┘ └────────────────────────────────┘

┌─ Model Performance Comparison ────────────────────────────────────────┐
│                                                                        │
│  ┌──────────────────┬────────────┬───────────┬──────────┬────────┐    │
│  │ Model            │ Avg Latency│ P95 Latency│ Calls   │ Errors │    │
│  ├──────────────────┼────────────┼───────────┼──────────┼────────┤    │
│  │ qwen3.5:35b      │ 1.2s       │ 3.8s      │ 2,340   │ 12     │    │
│  │ claude-sonnet-4-6│ 3.4s       │ 8.1s      │ 456     │ 3      │    │
│  │ gpt-4o           │ 1.8s       │ 4.2s      │ 89      │ 0      │    │
│  └──────────────────┴────────────┴───────────┴──────────┴────────┘    │
│                                                                        │
│  [Export CSV]                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

Data sources: The cost chart reads from the existing `costTracker.getCostSummary()` endpoint. The performance table reads from `{project}_llm_usage` collection data already captured by `llm-usage-logger.ts`. The budget progress bars compare current spend against the configured `budgets.daily_usd` and `budgets.monthly_usd`.

---

## 3. Model Discovery & Testing

### Auto-Discovery

**Ollama discovery** (already partially supported via the Ollama API):

```
GET http://localhost:11434/api/tags
Response:
{
  "models": [
    {
      "name": "qwen3.5:35b",
      "size": 21474836480,
      "modified_at": "2026-03-24T10:00:00Z",
      "details": {
        "parameter_size": "35B",
        "quantization_level": "Q4_K_M",
        "families": ["qwen3"],
        "format": "gguf"
      }
    },
    ...
  ]
}
```

**Implementation:** New API endpoint `GET /api/models/discover/:provider` that:
- For `ollama`: calls `GET {OLLAMA_URL}/api/tags`, parses response, adds capability flags
- For `openai`: calls `GET https://api.openai.com/v1/models`, filters to chat/embedding models
- For `anthropic`: returns a hardcoded list (Anthropic has no model listing API)
- For `custom`: attempts a health check `GET {url}/health` or sends a minimal test request

**Capability detection per model:**

```json
{
  "name": "qwen3.5:35b",
  "provider": "ollama",
  "capabilities": {
    "embeddings": false,
    "chat": true,
    "thinking": true,
    "tool_use": false,
    "json_mode": true,
    "vision": false,
    "streaming": true,
    "context_window": 32768,
    "max_output_tokens": 8192
  },
  "size_gb": 21,
  "quantization": "Q4_K_M"
}
```

For Ollama, capabilities are inferred from model family (qwen3 supports thinking; llava supports vision). For OpenAI/Anthropic, capabilities come from a static registry updated with the codebase.

### Model Testing Interface

**Dashboard page:** `/settings/models/test`

```
┌─ Model Comparison Test ───────────────────────────────────────────────┐
│                                                                        │
│  Test prompt:                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Explain what a circuit breaker pattern is in 2 sentences.       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  Models to test:                                                       │
│  [x] qwen3.5:35b (Ollama)                                            │
│  [x] claude-sonnet-4-6 (Anthropic)                                   │
│  [ ] gpt-4o (OpenAI)                                                  │
│                                                                        │
│  [Run Comparison]                                                      │
│                                                                        │
│  ┌──── qwen3.5:35b ─────────────┐  ┌── claude-sonnet-4-6 ──────────┐ │
│  │                               │  │                                │ │
│  │ A circuit breaker pattern     │  │ The circuit breaker pattern    │ │
│  │ prevents cascading failures   │  │ monitors for failures in a     │ │
│  │ by wrapping calls in a        │  │ downstream service and "trips" │ │
│  │ monitor that trips open...    │  │ open to short-circuit requests │ │
│  │                               │  │ when a failure threshold is... │ │
│  │ ──────────────────────────    │  │ ──────────────────────────     │ │
│  │ Latency:      1,234ms        │  │ Latency:      2,891ms         │ │
│  │ Tokens in:    42             │  │ Tokens in:    38              │ │
│  │ Tokens out:   67             │  │ Tokens out:   54              │ │
│  │ Cost:         $0.000         │  │ Cost:         $0.001          │ │
│  │ Thinking:     disabled       │  │ Thinking:     924 tokens      │ │
│  └───────────────────────────────┘  └────────────────────────────────┘ │
│                                                                        │
│  [Save Result] [Export JSON]                                           │
└────────────────────────────────────────────────────────────────────────┘
```

**API endpoint:** `POST /api/models/test`
```json
{
  "prompt": "Explain what a circuit breaker pattern is in 2 sentences.",
  "providers": [
    { "provider": "ollama", "model": "qwen3.5:35b" },
    { "provider": "anthropic", "model": "claude-sonnet-4-6" }
  ],
  "options": {
    "temperature": 0.7,
    "max_tokens": 256,
    "thinking": true
  }
}
```

Response includes per-provider results with latency, token usage, cost, and the response text. Saved results are stored in `{project}_model_tests` collection in Qdrant for historical comparison.

---

## 4. CLI Model Management

### `reka models list`

```
$ reka models list

  Active Model Configuration
  ─────────────────────────────────────────────────────────────

  Role          Provider    Model               Status     Latency
  ──────────    ────────    ─────────────────    ────────   ───────
  embeddings    bge-m3      BAAI/bge-m3          healthy    45ms
  llm.utility   ollama      qwen3.5:35b          healthy    1.2s
  llm.standard  ollama      qwen3.5:35b          healthy    1.2s
  llm.complex   anthropic   claude-sonnet-4-6    healthy    3.4s

  Fallback chains:
    ollama    -> anthropic -> openai
    anthropic -> ollama

  Config: /home/user/myproject/reka.config.yaml
```

### `reka models test`

```
$ reka models test

  Testing all configured providers...

  [1/4] BGE-M3 (embeddings)
        URL: http://localhost:8080
        Test: embed "hello world" (1024d)
        Result: OK (45ms, 1024 dimensions)

  [2/4] Ollama (utility + standard)
        URL: http://localhost:11434
        Model: qwen3.5:35b
        Test: "Respond with OK"
        Result: OK (1,234ms, 12 tokens)

  [3/4] Anthropic (complex)
        Model: claude-sonnet-4-6
        Test: "Respond with OK"
        Result: OK (891ms, 8 tokens, $0.000054)

  [4/4] OpenAI (fallback only)
        Status: SKIPPED (no API key configured)

  Summary: 3/4 providers healthy, 1 skipped
```

### `reka models add <provider>`

```
$ reka models add anthropic

  Configure Anthropic provider
  ─────────────────────────────

  API Key: sk-ant-••••••••••••
  ? Select model:
    > claude-sonnet-4-6 ($3/$15 per 1M tokens)
      claude-opus-4-6 ($15/$75 per 1M tokens)
      claude-haiku-4-5 ($0.80/$4 per 1M tokens)

  ? Assign to role:
    > complex (recommended for claude-sonnet-4-6)
      standard
      utility

  ? Enable thinking mode? (Y/n): Y
  ? Thinking effort [low/medium/high/max] (high): high

  Testing connection... OK (2,341ms)

  Updated reka.config.yaml:
    models.llm.complex.provider: anthropic
    models.llm.complex.model: claude-sonnet-4-6

  Run 'reka models test' to verify full configuration.
```

### `reka models switch <role> <provider>`

```
$ reka models switch complex openai

  Switching complex LLM: anthropic -> openai

  Current:  claude-sonnet-4-6 ($3/$15 per 1M tokens)
  New:      gpt-4o ($2.50/$10 per 1M tokens)

  Estimated monthly savings: ~$4.50 (based on last 30 days usage)

  Updated reka.config.yaml
  Changes take effect on next request (no restart needed).
```

### `reka models benchmark`

```
$ reka models benchmark

  Running standard benchmark (5 tasks x 3 providers)...

  Task                    Ollama/qwen3.5   Anthropic/sonnet  OpenAI/gpt-4o
  ──────────────────────  ──────────────   ────────────────  ─────────────
  Query rewrite (JSON)    0.8s / $0.000    2.1s / $0.0003   1.2s / $0.0002
  Code explanation        2.1s / $0.000    3.8s / $0.0012   2.4s / $0.0008
  PR review (500 LOC)     8.4s / $0.000    6.2s / $0.0089   5.1s / $0.0062
  Agent reasoning (3hop)  12.1s / $0.000   8.9s / $0.0234   9.8s / $0.0198
  Memory merge (5 items)  0.6s / $0.000    1.4s / $0.0002   0.9s / $0.0001

  Quality scores (0-10, judged by claude-opus-4-6):
  Task                    Ollama   Anthropic   OpenAI
  ──────────────────────  ──────   ─────────   ──────
  Query rewrite           7.2      8.8         8.5
  Code explanation        6.8      9.1         8.7
  PR review               5.9      9.4         8.9
  Agent reasoning          5.1      9.2         8.6
  Memory merge            7.5      8.1         7.9

  Recommendation:
    utility  -> Ollama (fast, free, adequate quality)
    standard -> Anthropic (best quality/cost ratio)
    complex  -> Anthropic (highest quality for critical tasks)

  Full results saved to: ~/.reka/benchmarks/2026-03-26T10-30-00.json
```

### `reka models cost-report`

```
$ reka models cost-report

  Cost Report: myproject
  Period: 2026-03-01 to 2026-03-26
  ─────────────────────────────────────────────

  Total: $34.12 (2.4M tokens, 3,285 calls)

  By Provider:
    Provider     Tokens     Calls    Cost
    ────────     ──────     ─────    ────
    ollama       1.2M       2,340    $0.00
    anthropic    890K       456      $31.50
    openai       120K       89       $2.62

  By Task Type:
    Task                  Cost      % of Total
    ────                  ────      ──────────
    agent_reasoning       $18.40    53.9%
    pr_review             $8.20     24.0%
    code_explanation      $4.90     14.4%
    memory_governance     $1.80     5.3%
    utility (all)         $0.82     2.4%

  Daily Average: $1.31
  Projected Monthly: $39.40

  Budget: $200.00/month (19.7% used)
    Daily: $10.00/day (13.1% used today)
```

---

## 5. Model Compatibility Matrix

| Feature | Ollama | OpenAI | Anthropic | BGE-M3 (self-hosted) | Azure OpenAI | Custom |
|---|---|---|---|---|---|---|
| **Embeddings** | Yes (bge-m3, nomic-embed) | Yes (text-embedding-3-*) | No | Yes (primary) | Yes | Yes (OpenAI-compatible) |
| **Chat/Completion** | Yes | Yes | Yes | No | Yes | Yes (OpenAI-compatible) |
| **Thinking/Reasoning** | Yes (think:true) | No | Yes (extended thinking) | N/A | No | Depends |
| **Tool Use (native)** | No | Yes (function calling) | Yes (tool_use) | N/A | Yes | Depends |
| **JSON Mode** | Yes (format:'json') | Yes (response_format) | Via system prompt | N/A | Yes | Depends |
| **Vision/Multimodal** | Yes (llava, etc.) | Yes (gpt-4o) | Yes (all Claude models) | N/A | Yes (gpt-4o) | Depends |
| **Streaming** | Yes | Yes | Yes | N/A | Yes | Depends |
| **Sparse Vectors** | No | No | N/A | Yes (primary) | No | Depends |
| **Batch Embeddings** | No (sequential) | Yes | N/A | Yes (/embed/batch) | Yes | Depends |
| **Cost** | Free (local GPU) | $0.15-10/1M tokens | $0.80-75/1M tokens | Free (local GPU) | Per Azure plan | Varies |
| **Latency** | Low (1-3s, GPU-bound) | Medium (1-4s) | Medium-High (2-8s) | Very Low (20-50ms) | Medium (1-4s) | Varies |
| **Privacy** | Full (local) | Data sent to OpenAI | Data sent to Anthropic | Full (local) | Per Azure config | Depends |
| **Circuit Breaker** | Yes (ollamaCircuit) | Yes (openaiCircuit) | Yes (anthropicCircuit) | Yes (embeddingCircuit) | Uses openaiCircuit | Custom needed |

### Recommended Model-Task Mapping

| Reka Task | Best Provider | Why |
|---|---|---|
| **Embeddings** | BGE-M3 (self-hosted) | Free, 1024d dense + sparse vectors for hybrid search, low latency (45ms), privacy |
| **Query rewriting** | Ollama (qwen3:8b) | Simple JSON task, no reasoning needed, sub-second, free |
| **Search reranking** | Ollama (qwen3:8b) | Score 5-10 results, fast turnaround critical for UX, free |
| **Memory merge/dedup** | Ollama (qwen3.5:35b) | Needs moderate reasoning to detect semantic overlap, free |
| **Routing decisions** | Ollama (qwen3:8b) | Pick from fixed set of options, deterministic JSON, free |
| **Code explanation** | Anthropic (Sonnet) or Ollama (35b) | Trade-off: Sonnet is higher quality but costs $0.001/request. Ollama is free but slower/lower quality |
| **Memory governance** | Ollama (qwen3.5:35b) or Anthropic (Sonnet) | Promote/reject decisions need good judgment. Ollama adequate for most cases |
| **Agent reasoning** | Anthropic (Sonnet/Opus) | Multi-step planning, tool orchestration, needs highest quality. Native tool_use support critical |
| **PR review** | Anthropic (Sonnet) | Long context, nuanced analysis, thinking traces valuable for explaining findings |
| **Architecture analysis** | Anthropic (Opus) | Most demanding task, benefits from max reasoning budget |

---

## 6. Smart Model Routing Engine

### Flow Diagram

```
Task arrives
     |
     v
[1. Classify complexity]          <-- Static task-type lookup from config
     |                                 (query_rewrite -> utility, etc.)
     |
     v
[2. Check experiments]            <-- If A/B experiment active for this task,
     |                                 roll dice: 10% -> variant_tier
     |
     v
[3. Check override]              <-- Per-project routing overrides
     |
     v
[4. Select provider]             <-- tier -> provider from config
     |                                 (utility -> ollama, complex -> anthropic)
     |
     v
[5. Check budget]                <-- Compare spend-so-far vs daily/monthly cap
     |                                 Over hard limit? -> REJECT with 429
     |                                 Over soft limit? -> LOG WARNING, proceed
     |
     v
[6. Execute]                     <-- Call provider with circuit breaker + retry
     |
     |--- Success --------> [7. Record usage] -> return result
     |
     |--- Failure --------> [8. Failover chain]
                                  |
                                  |--- Try next provider in chain
                                  |--- All failed? -> throw error
```

### Implementation: Enhanced `completeWithBestProvider`

The current `completeWithBestProvider` in `llm.ts` maps `ComplexityLevel` to a provider. The routing engine extends this with config-driven rules:

```typescript
// Pseudocode for the enhanced router
async route(task: string, prompt: string, options: CompletionOptions): Promise<CompletionResult> {
  // 1. Look up tier from task name
  let tier = this.config.routing.tasks[task] ?? 'standard';

  // 2. Check per-project overrides
  if (this.config.routing.overrides[task]) {
    tier = this.config.routing.overrides[task];
  }

  // 3. Check A/B experiments
  const experiment = this.config.routing.experiments.find(e => e.task === task);
  if (experiment && Math.random() * 100 < experiment.traffic_pct) {
    tier = experiment.variant_tier;
    options.metadata = { ...options.metadata, experiment_id: experiment.tracking_id };
  }

  // 4. Budget check
  const spend = await this.costTracker.getTodaySpend();
  if (this.config.budgets.daily_usd && spend >= this.config.budgets.daily_usd) {
    // Hard limit: downgrade to free tier or reject
    if (tier !== 'utility' || this.getProvider('utility') !== 'ollama') {
      throw new BudgetExceededError(`Daily budget $${this.config.budgets.daily_usd} exceeded`);
    }
  }
  if (this.config.budgets.warn_daily_usd && spend >= this.config.budgets.warn_daily_usd) {
    logger.warn('Daily budget warning threshold reached', { spend, threshold: this.config.budgets.warn_daily_usd });
  }

  // 5. Apply per-request token cap
  options.maxTokens = Math.min(
    options.maxTokens ?? 4096,
    this.config.budgets.per_request[tier] ?? 32768
  );

  // 6. Execute with failover
  return this.completeWithFailover(prompt, options, tier);
}
```

### Per-Task Routing Override

Users can override routing for individual API calls using an HTTP header:

```
X-Reka-Tier: complex
```

Or in code:
```typescript
await llm.completeWithBestProvider(prompt, {
  complexity: 'complex',  // existing API, unchanged
});
```

The YAML config provides the persistent defaults. The runtime call provides the per-request escape hatch.

### Quality Monitoring

Detect degraded responses by tracking two signals stored alongside usage data:

1. **Latency drift:** If P95 latency for a provider exceeds 3x its 7-day rolling average, mark it as `degraded`. The circuit breaker already handles outright failures; this catches slowdowns.

2. **Empty/truncated responses:** If more than 5% of responses from a provider in a 1-hour window have fewer than 10 tokens (for non-utility tasks), flag it. Likely cause: model overloaded, quota exceeded, or service degradation.

Implementation: A lightweight background check runs every 60 seconds, reading from the `llm_usage` buffer. If degraded, the dashboard card shows a yellow "degraded" status, and an alert is sent via the configured channel.

### A/B Testing Support

Experiment results are tracked by attaching `experiment_id` to the `LLMUsageEntry` payload. A new analytics endpoint `/api/models/experiments/:tracking_id` aggregates:
- Volume split (actual % routed to variant vs control)
- Latency comparison (mean, P50, P95)
- Cost comparison
- Quality comparison (if the benchmark scoring pipeline is available)

Dashboard shows an "Experiments" tab under Section D with a per-experiment card showing these metrics and a "Conclude Experiment" button that applies the winning config.

---

## 7. Migration Between Models

### The Problem

Switching embedding providers changes vector dimensions:
- BGE-M3: 1024 dimensions
- OpenAI `text-embedding-3-small`: 1536 dimensions
- OpenAI `text-embedding-3-large`: 3072 dimensions
- Ollama `nomic-embed-text`: 768 dimensions

All existing vectors in Qdrant become incompatible. Collections must be rebuilt.

### Migration Wizard (Dashboard)

Accessible from Settings > Models > Embeddings card > "Switch Provider" dropdown, when the new provider has different dimensions.

```
┌─ Embedding Migration Wizard ──────────────────────────────────────────┐
│                                                                        │
│  You are switching embeddings from BGE-M3 (1024d) to OpenAI (1536d). │
│  This requires re-embedding all indexed content.                       │
│                                                                        │
│  Step 1 of 4: Assessment                                               │
│  ─────────────────────                                                 │
│                                                                        │
│  Affected collections:                                                 │
│  ┌────────────────────────────┬──────────┬────────────┬──────────┐    │
│  │ Collection                 │ Points   │ Size (MB)  │ Est Time │    │
│  ├────────────────────────────┼──────────┼────────────┼──────────┤    │
│  │ myproject_codebase         │ 12,450   │ 48.2       │ ~15 min  │    │
│  │ myproject_docs             │ 890      │ 3.4        │ ~2 min   │    │
│  │ myproject_memory           │ 234      │ 0.9        │ <1 min   │    │
│  │ myproject_confluence       │ 1,200    │ 4.6        │ ~3 min   │    │
│  │ myproject_symbols          │ 5,670    │ 21.8       │ ~8 min   │    │
│  └────────────────────────────┴──────────┴────────────┴──────────┘    │
│                                                                        │
│  Total points: 20,444                                                  │
│  Estimated time: ~28 minutes                                           │
│  Estimated cost: $0.26 (OpenAI embeddings at $0.13/1M tokens)         │
│                                                                        │
│  [!] Search will be unavailable during migration.                      │
│      Existing collections will be preserved for rollback.              │
│                                                                        │
│  [Cancel]                                    [Next: Configure >]       │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Step 2 of 4: Configure                                                │
│  ─────────────────────                                                 │
│                                                                        │
│  New provider: OpenAI                                                  │
│  Model: text-embedding-3-small                                        │
│  Dimensions: 1536                                                      │
│  Sparse vectors: [!] Not available with OpenAI (hybrid search disabled)│
│                                                                        │
│  Migration strategy:                                                   │
│  (*) In-place (rename old -> backup, create new)                       │
│      - Search offline during migration                                 │
│      - Fastest                                                         │
│                                                                        │
│  ( ) Shadow (build new alongside old, swap atomically)                 │
│      - Search remains online                                           │
│      - Uses 2x storage temporarily                                     │
│      - Requires re-reading all source files                            │
│                                                                        │
│  [< Back]                                    [Next: Review >]          │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Step 3 of 4: Review                                                   │
│  ──────────────────                                                    │
│                                                                        │
│  Changes:                                                              │
│    VECTOR_SIZE: 1024 -> 1536                                           │
│    EMBEDDING_PROVIDER: bge-m3-server -> openai                        │
│    SPARSE_VECTORS_ENABLED: true -> false                              │
│                                                                        │
│  Collections to rebuild: 5                                             │
│  Backup collections: myproject_codebase_backup_20260326, ...          │
│                                                                        │
│  [< Back]                              [Start Migration]               │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Step 4 of 4: Progress                                                 │
│  ────────────────────                                                  │
│                                                                        │
│  Overall: [===================>            ] 67%                        │
│                                                                        │
│  myproject_codebase     [=====================] DONE (12,450 points)   │
│  myproject_docs         [=====================] DONE (890 points)      │
│  myproject_memory       [===========>         ] 52% (122/234 points)  │
│  myproject_confluence   [                     ] Pending                │
│  myproject_symbols      [                     ] Pending                │
│                                                                        │
│  Elapsed: 14m 23s | Remaining: ~8 min                                 │
│  Tokens used: 1.8M | Cost so far: $0.17                              │
│  Errors: 0                                                             │
│                                                                        │
│  [Cancel & Rollback]                                                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Migration Process (Backend)

New endpoint: `POST /api/models/migrate-embeddings`

```typescript
// Pseudocode for the migration pipeline
async migrateEmbeddings(project: string, newProvider: EmbeddingConfig): Promise<void> {
  const collections = await listProjectCollections(project);
  // e.g., ["myproject_codebase", "myproject_docs", "myproject_memory", ...]

  for (const collection of collections) {
    // 1. Create backup
    const backupName = `${collection}_backup_${Date.now()}`;
    await qdrant.createSnapshot(collection);  // or rename via alias

    // 2. Create new collection with new dimensions
    const newCollection = `${collection}_new`;
    await vectorStore.createCollection(newCollection, {
      vectorSize: newProvider.dimensions,
      sparseVectors: newProvider.sparse_vectors,
    });

    // 3. Scroll through old collection, re-embed payloads
    let offset = undefined;
    let migrated = 0;
    do {
      const batch = await qdrant.scroll(collection, { limit: 100, offset, with_payload: true });
      
      // Extract text from payloads
      const texts = batch.points.map(p => p.payload.content || p.payload.text || '');
      
      // Re-embed with new provider
      const newEmbeddings = await newEmbeddingService.embedBatch(texts);
      
      // Upsert into new collection (preserve original payload)
      const points = batch.points.map((p, i) => ({
        id: p.id,
        vector: newEmbeddings[i],
        payload: p.payload,
      }));
      await vectorStore.upsert(newCollection, points);
      
      migrated += points.length;
      emitProgress(collection, migrated, totalPoints);
      
      offset = batch.next_page_offset;
    } while (offset);

    // 4. Swap: delete old, rename new to original name
    await qdrant.deleteCollection(collection);
    // Qdrant doesn't support rename; use alias or recreate
    await swapCollectionAlias(collection, newCollection);
  }

  // 5. Update config
  updateConfig({ EMBEDDING_PROVIDER: newProvider.provider, VECTOR_SIZE: newProvider.dimensions });
}
```

### Rollback

If migration is cancelled or fails partway:
1. The backup collections (`*_backup_*`) still exist with old vectors.
2. `POST /api/models/rollback-migration` restores the backup aliases and reverts config.
3. Partial new collections are deleted.
4. Rollback takes seconds (alias swap, no re-embedding).

### Downtime Expectations

| Strategy | Search Downtime | Storage Overhead | Duration |
|---|---|---|---|
| In-place | Full duration of migration | ~0 (old deleted as new created) | 15-60 min per 10K points |
| Shadow | Zero (old collection serves queries) | 2x during migration | Same, but no user impact |

Recommendation: Use **shadow** strategy for production. Use **in-place** for dev/personal setups where brief downtime is acceptable.

### CLI Migration

```
$ reka models switch embeddings openai

  WARNING: Switching embedding provider requires re-embedding all content.
  Current: BGE-M3 (1024 dimensions, 20,444 points across 5 collections)
  New: OpenAI text-embedding-3-small (1536 dimensions)

  Estimated time: ~28 minutes
  Estimated cost: $0.26
  Strategy: shadow (search remains available)

  Proceed? [y/N]: y

  Migrating...
  [1/5] myproject_codebase    [===================] 100% (12,450 pts, 14m)
  [2/5] myproject_docs        [===================] 100% (890 pts, 2m)
  [3/5] myproject_memory      [===================] 100% (234 pts, 38s)
  [4/5] myproject_confluence  [===================] 100% (1,200 pts, 3m)
  [5/5] myproject_symbols     [===================] 100% (5,670 pts, 8m)

  Migration complete in 27m 42s
  Backup collections retained for 7 days (run 'reka models cleanup-backups' to remove)
  Config updated: EMBEDDING_PROVIDER=openai, VECTOR_SIZE=1536
```

---

## Summary

This design covers the complete model configuration lifecycle:

1. **`reka.config.yaml`** -- A single YAML file that replaces the current scattered `.env` variables for model configuration. Supports env var interpolation, per-tier settings, routing rules, experiments, fallback chains, and budgets. Five example configs cover the full spectrum from zero-config cloud to privacy-max local.

2. **Dashboard UI** -- Four-section settings page: active model cards with health/cost metrics, provider configuration with auto-discovery, visual routing rules with drag-and-drop fallback chains, and usage/cost analytics powered by the existing `llm-usage-logger.ts` and `cost-tracker.ts` infrastructure.

3. **Model discovery** -- Auto-detect Ollama models via `/api/tags`, capability detection per model (thinking, tool use, JSON mode, vision), and a side-by-side testing interface.

4. **CLI** -- Six commands (`list`, `test`, `add`, `switch`, `benchmark`, `cost-report`) with concrete output formats. The `add` command runs an interactive wizard; `benchmark` runs quality-scored comparisons.

5. **Compatibility matrix** -- Documents which providers support which features, and recommends the best provider for each Reka task type based on quality/cost/latency trade-offs.

6. **Routing engine** -- Extends the existing `completeWithBestProvider` with config-driven task mapping, per-project overrides, A/B experiment support (traffic splitting with tracking IDs), budget enforcement (hard limits reject, soft limits warn), and quality degradation detection.

7. **Embedding migration** -- Two strategies (in-place with downtime, shadow with zero downtime), a 4-step wizard with assessment/configure/review/progress phases, point-by-point re-embedding with progress tracking, backup retention for rollback, and CLI support.
