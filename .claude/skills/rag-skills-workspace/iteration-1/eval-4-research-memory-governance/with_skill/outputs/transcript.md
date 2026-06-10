# Research Transcript: Memory Governance System

## Task

"Як працює система memory governance? Де знаходиться логіка quarantine та promotion?"

## Step 1: Classification

The question is a hybrid of:

- **How** ("як працює") -- understand the mechanism
- **Where** ("де знаходиться") -- find quarantine and promotion logic

## Step 2: Broad Discovery (7 parallel RAG tool calls)

### Tool Call 1: `hybrid_search(query: "memory governance quarantine promotion", limit: 10)`

**Result:** Found 10 results. Top hits:

- `rag-api/src/services/memory-governance.ts:168-231` (MemoryGovernanceService.promote)
- `rag-api/src/routes/memory.ts:185-218` (recall-durable, promote routes)
- `mcp-server/src/tools/memory.ts:28-684` (createMemoryTools)
- `rag-api/src/utils/metrics.ts:270-275` (memoryGovernanceTotal counter)
- `rag-api/src/utils/validation.ts:134-142` (promoteMemorySchema)
- Graph-connected: `rag-api/src/services/memory.ts`, `rag-api/src/services/feedback.ts`

### Tool Call 2: `find_feature(description: "memory governance system with quarantine and promotion of memories")`

**Result:** Timeout after 120s (find_feature is a heavy operation)

### Tool Call 3: `search_graph(query: "memory governance quarantine promotion", expandHops: 1)`

**Result:** Found 5 direct matches + 16 graph-connected files:

- Direct: `memory-governance.ts` (class MemoryGovernanceService with all methods)
- Graph-connected: `memory.ts`, `feedback.ts`, `vector-store.ts`, `quality-gates.ts`, `metrics.ts`, `embedding.ts`, `session-context.ts`, `fact-extractor.ts`, `logger.ts`

### Tool Call 4: `get_patterns(query: "memory governance")`

**Result:** Found 8 architectural patterns. Most relevant:

- **"Memory Dual-Tier Governance"** -- describes quarantine/durable split, routing rules, promotion flow

### Tool Call 5: `find_symbol(symbol: "promote", kind: "function")`

**Result:** Found `applyFeedbackBoost` in search.ts (not the target symbol -- the symbol index uses prefix matching)

### Tool Call 6: `find_symbol(symbol: "quarantine")`

**Result:** Found 4 symbols in `memory-governance.ts`:

- `getQuarantineCollection`
- `recallQuarantine`
- `listQuarantine`
- `MemoryGovernanceService.getQuarantineCollection`

### Tool Call 7: `get_adrs(query: "memory governance quarantine")`

**Result:** Found 6 ADRs. Most relevant:

- "Context enrichment via before/after hooks in tool dispatch" -- explains recall-durable usage

## Step 3: Deep Dive (Read key files)

### Read 1: `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts`

**Result:** Full file (430 lines). Contains:

- `MemoryGovernanceService` class (lines 22-426)
- Methods: getAdaptiveThreshold, ingest, promote, reject, recallDurable, recallQuarantine, listQuarantine, autoPromoteByFeedback, autoPruneByFeedback, runFeedbackMaintenance
- Singleton export: `memoryGovernance`

### Read 2: `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`

**Result:** Full file (376 lines). Contains:

- POST /api/memory (lines 27-56) -- governance routing for auto\_\* source
- POST /api/memory/recall-durable (lines 185-197) -- durable-only recall
- POST /api/memory/promote (lines 203-215) -- promotion endpoint
- GET /api/memory/quarantine (lines 221-227) -- list quarantine
- POST /api/memory/maintenance (lines 358-362) -- feedback maintenance

### Read 3: `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts`

**Result:** Full file (488 lines). Contains MCP tool definitions:

- `promote_memory` tool (lines 361-401)
- `review_memories` tool (lines 307-358)
- `validate_memory` tool (lines 276-305)
- `memory_maintenance` tool (lines 448-485)

### Read 4: `/home/ake/shared-ai-infra/rag-api/src/services/quality-gates.ts`

**Result:** Full file (279 lines). Three quality gates:

- typeCheckGate (tsc --noEmit, 30s timeout)
- testGate (jest/vitest detection, 60s timeout)
- blastRadiusGate (graph-based, informational)

### Read 5: `/home/ake/shared-ai-infra/rag-api/src/services/feedback.ts` (lines 145-214)

**Result:** `submitMemoryFeedback()` method -- stores feedback with embeddings in Qdrant

### Read 6: `/home/ake/shared-ai-infra/mcp-server/src/tool-middleware.ts`

**Result:** Full file (283 lines). Middleware pipeline:

- auto-session -> enrichment.before -> handler -> enrichment.after -> trackUsage

### Read 7: `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`

**Result:** Full file (269 lines). Key finding:

- Uses `/api/memory/recall-durable` (line 199) -- only durable memories in enrichment

### Read 8: `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` (lines 1-50)

**Result:** Type definitions: MemoryType, MemorySource, Memory interface with governance fields (source, confidence, validated, relationships)

### Grep 1: `promoteMemorySchema` in validation.ts

**Result:** Zod schema at lines 134-142 with fields: memoryId, reason (enum), evidence, runGates, projectPath, affectedFiles

### Grep 2: `memoryGovernanceTotal` in metrics.ts

**Result:** Prometheus Counter with labels: operation, tier, project (lines 270-275)

## Step 4: Synthesis

Not needed -- direct file reads provided complete understanding.

## Step 5: Answer

Written to `answer.md` with structured "How" format including flow diagram, key components, file locations, and relationships.

## Tool Call Summary

| Tool                | Count  | Notes                                       |
| ------------------- | ------ | ------------------------------------------- |
| Read (SKILL.md)     | 1      | Workflow instructions                       |
| hybrid_search       | 1      | Broad discovery                             |
| find_feature        | 1      | Timed out (120s)                            |
| search_graph        | 1      | 5 direct + 16 connected files               |
| get_patterns        | 1      | Found "Memory Dual-Tier Governance" pattern |
| find_symbol         | 2      | Found quarantine-related symbols            |
| get_adrs            | 1      | Found 6 ADRs                                |
| Read (source files) | 8      | Deep dive into key files                    |
| Grep                | 2      | Validation schema + metrics                 |
| Glob                | 1      | Check output directory                      |
| Write               | 3      | answer.md, transcript.md, metrics.json      |
| **Total**           | **22** |                                             |
