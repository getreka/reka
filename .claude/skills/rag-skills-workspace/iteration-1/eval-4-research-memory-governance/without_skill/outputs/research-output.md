# Memory Governance System - Research Report

## Overview

The Memory Governance system is a two-tier storage architecture that separates auto-generated memories from human-validated ones. Its purpose is to prevent low-quality, auto-extracted learnings from polluting the durable memory store that is used for context enrichment during tool calls.

**Core principle:** Manual memories go directly to durable storage; auto-generated memories go to quarantine first, then must be promoted before they can influence future agent context.

---

## Architecture

### Two Collections per Project

| Collection | Purpose | Source |
|---|---|---|
| `{project}_agent_memory` | Durable storage. Used by `recall`, context enrichment, and briefings. | Manual `remember()`, promoted memories |
| `{project}_memory_pending` | Quarantine. Holds auto-generated memories awaiting review. | `auto_remember`, `fact_extractor`, conversation analysis |

### Data Flow

```
Manual memory (remember tool)
    │
    └──► memoryGovernance.ingest(source=undefined)
            │
            └──► memoryService.remember() ──► {project}_agent_memory (durable)

Auto memory (auto_remember, fact_extractor, conversation analysis)
    │
    └──► memoryGovernance.ingest(source='auto_*', confidence=N)
            │
            ├── confidence < adaptive_threshold ──► SKIP (not persisted)
            │
            └── confidence >= threshold ──► {project}_memory_pending (quarantine)
                    │
                    ├──► review_memories tool (list quarantine)
                    │
                    ├──► promote_memory tool ──► {project}_agent_memory (durable)
                    │       (reason: human_validated | pr_merged | tests_passed)
                    │       (optional: run quality gates before promotion)
                    │
                    ├──► validate_memory tool ──► reject (delete from quarantine)
                    │
                    └──► memory_maintenance ──► auto-promote (3+ accurate feedback)
                                             ──► auto-prune (2+ incorrect feedback)
```

---

## Key Files

### Core Governance Logic

**`/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts`** (430 lines)
- `MemoryGovernanceService` class (singleton exported as `memoryGovernance`)
- Central decision point: routes memories to durable or quarantine based on `source` field
- Methods:
  - `ingest()` - Routes memory based on source (manual vs auto_*)
  - `promote()` - Moves memory from quarantine to durable with metadata
  - `reject()` - Deletes memory from quarantine
  - `recallDurable()` - Search only durable storage (for enrichment)
  - `recallQuarantine()` - Search quarantine (for review)
  - `listQuarantine()` - Non-semantic listing (for review UI)
  - `getAdaptiveThreshold()` - Dynamic confidence threshold
  - `autoPromoteByFeedback()` - Auto-promote memories with 3+ positive feedback
  - `autoPruneByFeedback()` - Auto-delete memories with 2+ incorrect feedback
  - `runFeedbackMaintenance()` - Run both promote and prune in one pass

### Base Memory Service

**`/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`** (845 lines)
- `MemoryService` class (singleton exported as `memoryService`)
- Handles the actual storage in `{project}_agent_memory` collection
- Key features in `recall()`:
  - **Superseded filtering**: Memories marked as `supersededBy` are excluded from results
  - **Memory aging**: Unvalidated/unpromoted memories older than 30 days get score decay (5% per 30-day period, max 25% penalty)
  - **Relationship detection**: On `remember()`, auto-detects `supersedes`, `contradicts`, `relates_to`, `extends` relationships with existing memories

### API Routes

**`/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`** (376 lines)
- `POST /api/memory` - Routes auto-source memories through governance
- `POST /api/memory/recall` - Standard recall from durable
- `POST /api/memory/recall-durable` - Recall only from durable (for enrichment)
- `POST /api/memory/promote` - Promote quarantine memory to durable
- `GET /api/memory/quarantine` - List quarantine memories
- `POST /api/memory/maintenance` - Run feedback-driven maintenance

### MCP Tools (client-facing)

**`/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts`** (487 lines)
- `remember` - Stores manual memory (goes to durable directly)
- `recall` - Searches durable storage
- `review_memories` - Lists quarantine memories for human review
- `promote_memory` - Promotes a quarantine memory with reason + optional quality gates
- `validate_memory` - Validates or rejects an auto-extracted memory
- `memory_maintenance` - Runs auto-promote/prune cycle
- `run_quality_gates` - Runs tsc + tests + blast radius analysis

**`/home/ake/shared-ai-infra/mcp-server/src/tools/ask.ts`** (233 lines)
- `auto_remember` - Classifies content via LLM, saves with `source: 'auto_pattern'` and confidence score, which triggers governance routing through /api/memory endpoint

### Quality Gates

**`/home/ake/shared-ai-infra/rag-api/src/services/quality-gates.ts`** (279 lines)
- `QualityGateService` class
- Three gates run before optional gated promotion:
  1. **typeCheckGate**: `tsc --noEmit` (30s timeout)
  2. **testGate**: Detects vitest/jest, runs related tests (60s timeout)
  3. **blastRadiusGate**: Analyzes transitive dependents via graph store (informational, warns if >20 files)

### Fact Extractor

**`/home/ake/shared-ai-infra/rag-api/src/services/fact-extractor.ts`** (186 lines)
- Extracts structured facts from agent ReAct traces (observations only, not thoughts)
- Calls `memoryGovernance.ingest()` with `source: 'auto_pattern'` and confidence scores
- Facts are classified as: finding, dependency, pattern, issue
- All extracted facts go to quarantine

### Context Enrichment

**`/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`** (269 lines)
- Uses `/api/memory/recall-durable` endpoint (durable only)
- This ensures only validated/promoted memories are used to enrich tool responses
- Quarantine memories never leak into context enrichment

### Tests

**`/home/ake/shared-ai-infra/rag-api/src/__tests__/services/memory-governance.test.ts`** (295 lines)
- Tests for all key flows:
  - Manual memory routes to durable via memoryService.remember
  - Auto memory routes to quarantine collection
  - Below-threshold auto memory is skipped (not persisted)
  - Promote moves from quarantine to durable
  - Quality gate failure blocks promotion
  - Reject deletes from quarantine
  - Adaptive threshold computation

### Metrics

**`/home/ake/shared-ai-infra/rag-api/src/utils/metrics.ts`**
- Prometheus counter: `memory_governance_total`
- Labels: `operation` (ingest/promote/reject/prune), `tier` (durable/quarantine), `project`

---

## Detailed Mechanism Analysis

### 1. Ingest Routing (memory-governance.ts, lines 91-163)

The `ingest()` method is the entry point for all governed memory storage:

```typescript
const isAuto = source && source.startsWith('auto_');

if (!isAuto) {
  // Manual memory → durable via memoryService.remember()
  return memoryService.remember(memoryOptions);
}

// Auto → check adaptive threshold → quarantine
const threshold = await this.getAdaptiveThreshold(projectName);
if (confidence !== undefined && confidence < threshold) {
  // Return stub with {skipped: true}, NOT persisted
  return { ... metadata: { skipped: true, reason: 'below_threshold' } };
}

// Quarantine: embed + upsert to {project}_memory_pending
await vectorStore.upsert(quarantineCollection, [point]);
```

Source types are: `'manual'`, `'auto_conversation'`, `'auto_pattern'`, `'auto_feedback'`.

### 2. Adaptive Confidence Threshold (memory-governance.ts, lines 38-85)

The threshold dynamically adjusts based on historical promotion success:

- Counts promoted memories (durable with `originalSource=auto_*`)
- Counts pending memories (still in quarantine)
- `successRate = promoted / (promoted + pending)`
- `threshold = 0.8 - successRate * 0.4` (range: [0.4, 0.8])
- Default: 0.5 when fewer than 5 total memories exist
- Cached per project for 30 minutes

**Interpretation**: High promotion success rate lowers the threshold (accepts more auto-memories). High rejection rate raises it (filters more aggressively).

### 3. Promotion (memory-governance.ts, lines 168-231)

```typescript
// Optional: run quality gates (tsc, tests, blast radius)
if (gateOptions?.runGates) {
  const report = await qualityGates.runGates({...});
  if (!report.passed) throw new Error(`Quality gates failed: ...`);
}

// Find memory in quarantine by ID
// Delete from quarantine
await vectorStore.delete(quarantineCollection, [memoryId]);

// Save to durable via memoryService.remember() with enriched metadata
const promotedMemory = await memoryService.remember({
  ...originalPayload,
  metadata: {
    validated: true,
    promotedAt: new Date().toISOString(),
    promoteReason: reason,  // 'human_validated' | 'pr_merged' | 'tests_passed'
    promoteEvidence: evidence,
    originalSource: payload.source,
    originalConfidence: payload.confidence,
  },
});
```

### 4. Feedback-Driven Maintenance (memory-governance.ts, lines 330-425)

Automated maintenance based on accumulated user feedback:

- **Auto-promote**: Memories with 3+ `accurate` feedback are promoted with reason `'human_validated'`
- **Auto-prune**: Memories with 2+ `incorrect` feedback are deleted from both quarantine and durable
- Both run in parallel via `runFeedbackMaintenance()`

### 5. Memory Aging (memory.ts, lines 167-189)

In `recall()`, unvalidated/unpromoted memories older than 30 days receive score decay:
- 5% penalty per 30-day period past the first 30 days
- Maximum 25% total penalty
- Validated (`validated: true`) or promoted (`metadata.promotedAt`) memories are exempt

### 6. Relationship Detection (memory.ts, lines 728-778)

When a new memory is stored via `memoryService.remember()`:
- Searches for semantically similar existing memories (score > 0.75)
- Classifies relationships:
  - `supersedes`: same type + score > 0.85
  - `contradicts`: same type + score > 0.8 + negation language
  - `relates_to`: score > 0.75
- Superseded memories are marked with `supersededBy` and filtered out of future `recall()` results

---

## Summary

The memory governance system provides a robust pipeline for quality control of agent-generated knowledge:

1. **Ingestion gate**: Auto-generated memories must pass an adaptive confidence threshold
2. **Quarantine isolation**: Auto-memories are stored in a separate collection, invisible to context enrichment
3. **Multiple promotion paths**: Human validation, PR merge, test passage, or accumulated positive feedback
4. **Quality gates**: Optional tsc/test/blast-radius checks before promotion
5. **Feedback loop**: User feedback on memory accuracy drives automatic promotion and pruning
6. **Aging decay**: Old unvalidated memories naturally lose relevance in search results
7. **Relationship management**: New memories can supersede or contradict old ones, keeping the knowledge base fresh
