## Debug: recall повертає порожній масив навіть коли є memories в колекції

### Root Cause

Виявлено **три дефекти** різного рівня критичності, які разом або окремо призводять до порожнього результату recall:

**1. (PRIMARY) Aggressive superseded filtering -- всі memories позначаються як superseded**

Файл: `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`, рядки 170-171, 728-778

При кожному виклику `remember()` метод `detectRelationships()` (рядок 112) шукає існуючі memories з score > 0.85 того ж типу і автоматично позначає їх як superseded через `markSuperseded()`. Це створює каскадний ефект:

```
Memory A (stored) → Memory B (stored, A marked superseded) → Memory C (stored, B marked superseded)
```

В `recall()` рядок 171 фільтрує ВСІ superseded memories:
```typescript
.filter(r => !r.payload.supersededBy) // Exclude superseded memories
```

Якщо user зберігає кілька memories одного типу на близьку тему (що є типовим сценарієм -- оновлення контексту, уточнення рішень), то **всі старі memories стають superseded**, а залишається тільки найновіша. Якщо search повертає лише superseded memories (через `limit * 2` over-fetch), результат -- порожній масив.

Поріг `0.85` для supersedes в `detectRelationships()` (рядок 748) є занадто агресивним для memories одного типу. Для порівняння, звичайні codebase chunks мають similarity 0.7-0.9 навіть для різних тем.

**2. (SECONDARY) Context enrichment читає неправильне поле відповіді API**

Файл: `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`, рядки 227 та 241

```typescript
// BUG: API повертає { results: [...] }, а не { memories: [...] }
if (memoriesRes?.data?.memories) {    // <-- завжди undefined!
    for (const m of memoriesRes.data.memories) { ...
```

API endpoint `/api/memory/recall-durable` повертає `res.json({ results })` (memory routes, рядок 196), але context enrichment перевіряє `data.memories`. Результат: context enrichment **ніколи** не додає recalled memories до enrichable tools (search_codebase, ask_codebase, etc.). Це не впливає на прямий виклик `recall` MCP tool, але означає що весь механізм auto-enrichment зламаний.

**3. (DESIGN ISSUE) vectorStore.search() silently returns [] для неіснуючих колекцій**

Файл: `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts`, рядки 522-525

```typescript
if (error.status === 404) {
    return [];  // Silent empty return, no logging
}
```

Якщо колекція `{project}_agent_memory` не створена (ще не було жодного `remember()` виклику), search повертає порожній масив без жодного логування. Це ускладнює діагностику: user бачить "пусто" і не розуміє чому -- нема ні помилок в логах, ні підказки що колекція не існує.

### Trace

```
MCP recall tool (memory.ts:80-99)
  → ctx.api.post("/api/memory/recall", {query, type, limit})
    → Route POST /api/memory/recall (memory routes:62-74)
      → memoryService.recall({projectName, query, type, limit})
        → memory.ts:142-212
          → embeddingService.embed(query)                        // OK
          → vectorStore.search(collectionName, embedding, limit*2, filter)
            → vector-store.ts:509-515 TRY named vector search → FAIL (400)
            → vector-store.ts:527-536 CATCH → fallback anonymous → returns N results
          → results.filter(r => !r.payload.supersededBy)         // ← ФІЛЬТРУЄ ВСІ?
          → .slice(0, limit)                                     // ← ПОРОЖНІЙ МАСИВ
```

### Fix

**Fix 1: Зменшити агресивність auto-supersede** (memory.ts)

```typescript
// Рядок 748: підвищити поріг з 0.85 до 0.92 для supersedes
if (r.score > 0.92 && existingType === type) {
```

Або краще -- вимагати підтвердження через LLM, що нова memory дійсно замінює стару:

```typescript
if (r.score > 0.90 && existingType === type) {
  // Додати LLM перевірку чи це дійсно supersede
  const isSupersede = await this.confirmSupersede(content, r.payload.content as string);
  if (isSupersede) {
    relations.push({ targetId: r.id, type: 'supersedes', ... });
  }
}
```

**Fix 2: Виправити field name в context enrichment** (context-enrichment.ts)

```typescript
// Рядки 227 та 241: змінити 'memories' на 'results'
if (memoriesRes?.data?.results) {
    for (const m of memoriesRes.data.results) { ...
}
if (decisionsRes?.data?.results) {
    for (const m of decisionsRes.data.results) { ...
}
```

**Fix 3: Додати логування для пустих recall results** (memory.ts)

```typescript
// Після рядка 165:
if (results.length === 0) {
  logger.debug('Recall returned 0 results from vector store', {
    project: projectName, collection: collectionName, query: query.slice(0, 100)
  });
  return [];
}

const supersededCount = results.filter(r => r.payload.supersededBy).length;
if (supersededCount === results.length) {
  logger.warn('All recall results filtered as superseded', {
    project: projectName, total: results.length, superseded: supersededCount
  });
}
```

**Fix 4: Додати логування для 404 в vectorStore.search()** (vector-store.ts)

```typescript
// Рядок 523:
if (error.status === 404) {
  logger.debug('Search on non-existent collection', { collection });
  return [];
}
```

### Blast Radius

- `rag-api/src/services/memory.ts` -- recall(), detectRelationships(), markSuperseded()
- `mcp-server/src/context-enrichment.ts` -- recallWithTimeout() -- broken auto-enrichment for all enrichable tools
- `rag-api/src/services/memory-governance.ts` -- recallDurable() delegates to memoryService.recall(), same issue
- `rag-api/src/services/vector-store.ts` -- search() silent 404 handling
- Всі MCP tools з enrichment (search_codebase, ask_codebase, explain_code, find_feature, review_code, generate_tests, suggest_implementation, suggest_related_code, check_architecture, context_briefing, run_agent) -- не отримують context enrichment через Bug 2

### Prevention

1. **Додати integration test** для recall flow: store 5 memories одного типу, verify що recall повертає щонайменше 1 результат
2. **Додати integration test** для context enrichment: mock API, verify що recalled memories парсяться з response
3. **Моніторинг superseded ratio**: якщо >80% memories в колекції superseded, генерувати warning
4. **Response field contract tests**: validate що API route response shape відповідає тому що читає client (context-enrichment, MCP tools)
5. **Підвищити LOG_LEVEL для memory operations** з info до debug для діагностики подібних silent failures
