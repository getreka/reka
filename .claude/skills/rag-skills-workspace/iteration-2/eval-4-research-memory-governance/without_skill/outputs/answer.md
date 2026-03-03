# Memory Governance System -- Research Findings

## Overview

The memory governance system implements a **two-tier storage model** that separates auto-generated memories from human-created ones. Manual memories go directly to durable storage; auto-generated memories are routed to a quarantine tier where they must be explicitly promoted (or auto-promoted via feedback) before they participate in context enrichment.

### Core Principle

- **Manual memories** (from `remember`, `record_adr`, etc.) --> stored immediately in `{project}_agent_memory` (durable)
- **Auto-generated memories** (from conversation analysis, agent fact extraction, auto_remember) --> stored in `{project}_memory_pending` (quarantine), gated by an adaptive confidence threshold

---

## Key Files and Their Roles

| File | Role |
|------|------|
| `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts` | **Central governance service** -- routing, quarantine, promotion, rejection, adaptive threshold, feedback-driven maintenance |
| `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` | **Durable memory service** -- CRUD on `{project}_agent_memory`, relationship detection, aging, merge |
| `/home/ake/shared-ai-infra/rag-api/src/services/quality-gates.ts` | **Quality gates** -- typecheck, test, blast-radius checks run before optional gated promotion |
| `/home/ake/shared-ai-infra/rag-api/src/services/feedback.ts` | **Feedback service** -- collects accurate/outdated/incorrect signals, provides counts for auto-promote/prune |
| `/home/ake/shared-ai-infra/rag-api/src/services/conversation-analyzer.ts` | **Auto-learning** -- extracts learnings from conversations, routes them through governance |
| `/home/ake/shared-ai-infra/rag-api/src/services/fact-extractor.ts` | **Agent fact extraction** -- parses agent ReAct traces, saves structured facts to quarantine |
| `/home/ake/shared-ai-infra/rag-api/src/services/session-context.ts` | **Session lifecycle** -- on `endSession`, saves pending learnings through governance |
| `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts` | **HTTP API** -- endpoints for promote, quarantine list, recall-durable, maintenance |
| `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts` | **MCP tools** -- `promote_memory`, `review_memories`, `validate_memory`, `memory_maintenance` |
| `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts` | **Context enrichment** -- recalls ONLY from durable (`/api/memory/recall-durable`) |
| `/home/ake/shared-ai-infra/rag-api/src/__tests__/services/memory-governance.test.ts` | **Unit tests** for the governance service |

---

## Qdrant Collections

| Collection | Description |
|------------|-------------|
| `{project}_agent_memory` | **Durable storage** -- validated, promoted, and manually-created memories |
| `{project}_memory_pending` | **Quarantine** -- auto-generated memories awaiting review/promotion |
| `{project}_memory_feedback` | Stores per-memory feedback signals (accurate/outdated/incorrect) |
| `{project}_search_feedback` | Stores per-query search feedback |

---

## Detailed Flow

### 1. Ingestion (`memoryGovernance.ingest()`)

The `ingest()` method in `MemoryGovernanceService` (line 91, memory-governance.ts) is the single entry point for governed memory creation:

```typescript
async ingest(options: IngestOptions): Promise<Memory>
```

**Routing logic:**
- If `source` is undefined or does NOT start with `auto_` --> calls `memoryService.remember()` directly (durable)
- If `source` starts with `auto_` (e.g., `auto_conversation`, `auto_pattern`, `auto_feedback`):
  1. Computes adaptive confidence threshold
  2. If confidence < threshold --> returns a stub with `{ skipped: true, reason: 'below_threshold' }` (not persisted)
  3. Otherwise --> embeds and upserts to `{project}_memory_pending` with `validated: false`

### 2. Adaptive Confidence Threshold (`getAdaptiveThreshold()`)

The system dynamically adjusts how strict it is about accepting auto-memories based on historical promotion success:

```
threshold = max(0.4, min(0.8, 0.8 - successRate * 0.4))
```

Where `successRate = promoted / (promoted + pending)`.

- **High promotion rate** (most auto-memories get promoted) --> threshold drops toward 0.4 (more permissive)
- **Low promotion rate** (most auto-memories stay pending/rejected) --> threshold rises toward 0.8 (more strict)
- **Default**: 0.5 when fewer than 5 total memories exist
- **Cache**: Results cached per project for 30 minutes

### 3. Promotion (`memoryGovernance.promote()`)

Moves a memory from quarantine to durable storage:

```typescript
async promote(projectName, memoryId, reason, evidence?, gateOptions?)
```

**Steps:**
1. **Optional quality gates**: If `runGates: true`, runs typecheck + test + blast-radius gates. Fails if any gate fails.
2. Finds memory in quarantine via Qdrant scroll + filter
3. Deletes from `{project}_memory_pending`
4. Calls `memoryService.remember()` to store in `{project}_agent_memory` with metadata:
   - `validated: true`
   - `promotedAt`, `promoteReason`, `promoteEvidence`
   - `originalSource`, `originalConfidence`

**Promotion reasons** (type `PromoteReason`):
- `human_validated` -- a human reviewed and approved
- `pr_merged` -- related PR was merged
- `tests_passed` -- related tests passed

### 4. Rejection (`memoryGovernance.reject()`)

Simple deletion from quarantine:

```typescript
async reject(projectName, memoryId): Promise<boolean>
```

### 5. Quality Gates (`quality-gates.ts`)

Three gates, run before promotion if requested:

| Gate | Action | Behavior |
|------|--------|----------|
| `typecheck` | `tsc --noEmit` | Fails if type errors found (30s timeout) |
| `test` | Detects vitest/jest/npm test, runs related tests | Fails if tests fail (60s timeout) |
| `blast_radius` | Graph traversal via graph-store | Warns if >20 files affected (informational) |

### 6. Feedback-Driven Maintenance

The `runFeedbackMaintenance()` method combines two operations:

#### Auto-Promote (`autoPromoteByFeedback`)
- Queries `{project}_memory_feedback` for all memory feedback
- Memories with **3+ "accurate" feedback** are automatically promoted from quarantine to durable
- Uses `human_validated` reason with evidence noting the feedback count

#### Auto-Prune (`autoPruneByFeedback`)
- Memories with **2+ "incorrect" feedback** are deleted
- Tries quarantine first, then durable (can prune from either tier)

### 7. Recall Isolation

A critical design decision: **context enrichment only reads from durable storage**.

- `recallDurable()` delegates to `memoryService.recall()` (searches `{project}_agent_memory`)
- `recallQuarantine()` searches `{project}_memory_pending` (only for review UI)
- The `ContextEnricher` (context-enrichment.ts) calls `/api/memory/recall-durable` -- quarantine memories never contaminate tool enrichment

### 8. Memory Aging (in `memory.ts`)

Even within durable storage, unvalidated/unpromoted memories decay over time:

- Memories older than 30 days without `validated=true` or `promotedAt` metadata lose score
- Decay: 5% per additional 30-day period, capped at 25% maximum penalty
- Validated/promoted memories retain full score indefinitely

### 9. Memory Relationships (in `memory.ts`)

When a new memory is stored via `memoryService.remember()`:

- Auto-detects relationships with existing memories using embedding similarity:
  - **supersedes** (>0.85 similarity, same type): marks the old memory as superseded
  - **contradicts** (>0.80 similarity, negation language detected)
  - **relates_to** (>0.75 similarity)
- Superseded memories are filtered out during recall

---

## Sources of Auto-Generated Memories

| Source | `MemorySource` Value | Origin |
|--------|---------------------|--------|
| Conversation analysis | `auto_conversation` | `conversationAnalyzer.saveLearnings()` -- LLM extracts decisions/insights from text |
| Agent fact extraction | `auto_pattern` | `factExtractor.saveFacts()` -- parses agent ReAct observation traces |
| Auto-remember tool | `auto_pattern` | MCP `auto_remember` tool -- LLM classifies content, saves via `/api/memory` with metadata.source |
| Session end | `auto_conversation` | `sessionContext.endSession()` -- saves pending learnings through governance |

All of these call `memoryGovernance.ingest()` with an `auto_*` source, so they all route through the quarantine path.

---

## HTTP API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/memory` | POST | Create memory (routes auto-sources through governance) |
| `/api/memory/recall` | POST | Recall from durable only |
| `/api/memory/recall-durable` | POST | Explicit durable-only recall (used by enrichment) |
| `/api/memory/quarantine` | GET | List quarantine memories for review |
| `/api/memory/promote` | POST | Promote from quarantine to durable |
| `/api/memory/:id/validate` | PATCH | Mark memory as validated/rejected |
| `/api/memory/unvalidated` | GET | Get unvalidated auto-extracted memories |
| `/api/memory/maintenance` | POST | Run auto-promote + auto-prune |
| `/api/quality/run` | POST | Run quality gates on demand |

---

## MCP Tool Surface

| Tool | Purpose |
|------|---------|
| `remember` | Manual memory --> durable directly |
| `auto_remember` | LLM-classified --> routes through governance (quarantine) |
| `review_memories` | Lists quarantine (`{project}_memory_pending`) for human review |
| `validate_memory` | Validates/rejects memory in durable storage |
| `promote_memory` | Promotes quarantine --> durable, with optional quality gates |
| `run_quality_gates` | Runs typecheck/test/blast-radius independently |
| `memory_maintenance` | Runs feedback-driven auto-promote (3+ accurate) and auto-prune (2+ incorrect) |

---

## Architecture Diagram

```
 MCP Tool / Session End / Agent Task
           |
           v
  memoryGovernance.ingest()
           |
     source starts with "auto_"?
    /                        \
   NO                        YES
   |                          |
   v                   getAdaptiveThreshold()
 memoryService.remember()     |
   |                   confidence < threshold?
   v                  /                 \
 {project}_agent_memory               YES --> skip (stub returned)
 (durable)                              |
                                        NO
                                        |
                                        v
                                 {project}_memory_pending
                                 (quarantine)
                                        |
              +-----------+-------------+-----------+
              |           |                         |
         human review   3+ accurate          2+ incorrect
              |         feedback              feedback
              v           v                     v
          promote()   autoPromoteByFeedback   autoPruneByFeedback
              |           |                     |
        [quality gates?]  |                   delete()
              |           |
              v           v
      memoryService.remember()
              |
              v
    {project}_agent_memory (durable)
              |
              v
    Used by ContextEnricher.recallDurable()
    for tool enrichment
```

---

## Summary

The memory governance system provides a complete lifecycle for memory quality control:

1. **Intake routing**: Manual memories bypass governance; auto-memories are gated by adaptive confidence thresholds
2. **Quarantine**: Auto-memories land in `{project}_memory_pending` with `validated: false`
3. **Promotion paths**: Human validation, PR merge evidence, test passage, or 3+ positive feedback signals
4. **Quality gates**: Optional typecheck/test/blast-radius checks before promotion
5. **Pruning**: 2+ incorrect feedback signals trigger automatic deletion from either tier
6. **Isolation**: Context enrichment exclusively queries durable storage, preventing low-quality auto-memories from influencing tool responses
7. **Aging**: Even durable memories decay if unvalidated, ensuring stale content loses relevance naturally
