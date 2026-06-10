# Memory Governance Research - Transcript

## Task

"Як працює система memory governance? Де знаходиться логіка quarantine та promotion?"

## Tool Calls

### 1. Initial Search (4 parallel calls)

**Tool: mcp**rag**hybrid_search**

- Query: "memory governance quarantine promotion"
- Limit: 10
- Result: Found key files:
  - `rag-api/src/services/memory-governance.ts` (core governance service)
  - `rag-api/src/routes/memory.ts` (API routes)
  - `mcp-server/src/tools/memory.ts` (MCP tool definitions)
  - `rag-api/src/utils/metrics.ts` (Prometheus metrics)
  - `rag-api/src/utils/validation.ts` (Zod schemas)
  - `rag-api/src/services/memory.ts` (base memory service)
  - `rag-api/src/services/feedback.ts` (feedback-driven maintenance)

**Tool: Grep** (quarantine|memory_pending|durable)

- Found 10 files referencing quarantine/memory_pending/durable

**Tool: Grep** (promote_memory|promoteMemory|promote)

- Found 11 files referencing promotion logic

**Tool: Grep** (auto_remember|autoRemember|auto-remember)

- Found 2 files with auto_remember

### 2. Read Core Files (3 parallel reads)

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts`

- Full file (430 lines): MemoryGovernanceService class
- Methods: ingest, promote, reject, recallDurable, recallQuarantine, listQuarantine, autoPromoteByFeedback, autoPruneByFeedback, runFeedbackMaintenance, getAdaptiveThreshold

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`

- Full file (376 lines): Express Router with endpoints
- Governance endpoints: POST /memory (routes auto to governance), POST /memory/recall-durable, POST /memory/promote, GET /memory/quarantine, POST /memory/maintenance

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`

- Full file (845 lines): MemoryService class
- Methods: remember, recall (with aging/superseded filtering), list, forget, forgetByType, updateTodoStatus, getStats, batchRemember, validateMemory, mergeMemories, detectRelationships, markSuperseded, getUnvalidatedMemories

### 3. Read Supporting Files (4 parallel reads)

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/quality-gates.ts`

- Full file (279 lines): QualityGateService
- Gates: typeCheckGate (tsc --noEmit), testGate (vitest/jest), blastRadiusGate (graph store)

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/feedback.ts` (first 60 lines)

- FeedbackService types and interfaces

**Tool: Read** - `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`

- Full file (269 lines): ContextEnricher class
- Uses /api/memory/recall-durable (durable only) for enrichment
- Ensures only validated memories enrich tool responses

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/fact-extractor.ts` (first 80 lines)

- FactExtractorService: extracts structured facts from agent ReAct traces
- Routes extracted facts to quarantine via memoryGovernance.ingest() with source='auto_pattern'

### 4. Read Fact Extractor remainder

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/services/fact-extractor.ts` (lines 80-186)

- saveFacts method: calls memoryGovernance.ingest() with source='auto_pattern' and confidence scores
- saveAuditLog: Redis with 24h TTL
- classifyFact: pattern/dependency/issue/finding

### 5. Read MCP Memory Tools

**Tool: Grep** - promote_memory|review_memories|memory_maintenance in memory.ts

- Found tool definitions at lines 308, 362, 449

**Tool: Read** - `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts` (lines 300-487)

- review_memories: GET /api/memory/quarantine, shows pending items
- promote_memory: POST /api/memory/promote with reason + optional quality gates
- memory_maintenance: POST /api/memory/maintenance (auto-promote/prune by feedback)

### 6. Read auto_remember tool

**Tool: Grep** - auto_remember in ask.ts with context

- Found at line 171

**Tool: Read** - `/home/ake/shared-ai-infra/mcp-server/src/tools/ask.ts` (lines 195-233)

- auto_remember: analyzes content, classifies type, saves with source='auto_pattern' and confidence
- Routes through /api/memory which triggers governance routing

### 7. Read Tests

**Tool: Read** - `/home/ake/shared-ai-infra/rag-api/src/__tests__/services/memory-governance.test.ts`

- Full file (295 lines): Tests for ingest (manual→durable, auto→quarantine, below-threshold skip), promote (quarantine→durable, not found, quality gate failure), reject, recallDurable, getAdaptiveThreshold

### 8. Metrics

**Tool: Grep** - memoryGovernanceTotal in metrics.ts

- Counter: memory_governance_total with labels [operation, tier, project]
- Operations: ingest, promote, reject, prune

## Total Tool Calls Summary

| Tool                    | Count  |
| ----------------------- | ------ |
| mcp**rag**hybrid_search | 1      |
| Grep                    | 6      |
| Read                    | 10     |
| **Total**               | **17** |
