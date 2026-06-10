# Debug: recall повертає порожній масив навіть коли є memories в колекції

## Root Cause

Знайдено **3 проблеми**, з яких 2 є підтвердженими багами:

### Проблема #1 (ОСНОВНА): Тихий повернення пустого масиву при 404

**Файл**: `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts`, рядки 522-525

```typescript
} catch (error: any) {
  if (error.status === 404) {
    return [];  // Тихо повертає порожній масив, без логування
  }
```

Метод `vectorStore.search()` перехоплює помилку 404 від Qdrant і повертає порожній масив **без жодного логу**. Якщо колекція `{project}_agent_memory` не існує (була видалена, перейменована, або ніколи не була створена), recall завжди повертає `[]`.

`MemoryService.recall()` не перевіряє і не логує ситуацію, коли пошук повернув нуль результатів. MCP інструмент `recall` просто виводить "No memories found".

**Чому "немає помилок в логах"**: 404 перехоплюється і проковтується. Жодна ланка ланцюга (vectorStore -> memoryService -> route -> MCP tool) не логує порожній результат.

**Чому "memories існують"**: Користувач може перевіряти наявність memories іншим шляхом (dashboard, list_memories, API), або memories були збережені, але колекція з тих пір зникла.

### Проблема #2 (ПІДТВЕРДЖЕНИЙ БАГ): Невірне ім'я поля в context enrichment

**Файл**: `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`, рядки 227 та 241

```typescript
// Рядок 227 — ПОМИЛКА
if (memoriesRes?.data?.memories) {  // API повертає .results, не .memories!

// Рядок 241 — ПОМИЛКА
if (decisionsRes?.data?.memories) {  // Аналогічно
```

API роути `/api/memory/recall` та `/api/memory/recall-durable` повертають `{ results: [...] }`, але `recallWithTimeout` зчитує `memoriesRes.data.memories`, яке завжди `undefined`. Це означає що **контекстне збагачення ніколи не працює** — всі enrichable tools (search_codebase, ask_codebase, тощо) не отримують автоматичний контекст з пам'яті.

Примітка: `context_briefing` в `suggestions.ts` (рядок 89) правильно читає обидва варіанти:

```typescript
const memories =
  memoriesRes?.data?.results || memoriesRes?.data?.memories || [];
```

### Проблема #3 (ЛАТЕНТНА): Ланцюгове supersede

**Файл**: `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`, рядки 748, 171

При збереженні нової пам'яті, `detectRelationships()` позначає старі memories як superseded якщо:

- Схожість > 0.85 (cosine similarity)
- Той самий тип (decision, insight, тощо)

На recall, рядок 171 фільтрує всі superseded memories:

```typescript
.filter(r => !r.payload.supersededBy)
```

Якщо в колекції багато однотипних і схожих memories, більшість може бути позначена як superseded, залишаючи мінімум результатів.

## Trace

```
MCP recall tool (memory.ts:85)
  → POST /api/memory/recall (routes/memory.ts:62)
    → memoryService.recall() (memory.ts:142)
      → embeddingService.embed(query) (memory.ts:146)
      → vectorStore.search(collection, embedding, limit*2) (memory.ts:160)
        → Qdrant client.search() з named vector { name: 'dense' }
          → FAIL (collection has anonymous vectors) → catch
            → error.status === 404? → return [] (silent!)     ← Проблема тут
            → error.status === 400? → fallback to anonymous vector search
      → .filter(r => !r.payload.supersededBy)  ← Додаткове зменшення
      → .slice(0, limit)
  → res.json({ results })
MCP tool reads response.data.results → []
  → "No memories found"
```

## Fix

### Fix #1: Додати логування при 404 та порожніх результатах

**Файл**: `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts`

```typescript
// Рядок 522-525: додати логування
if (error.status === 404) {
  logger.warn(
    `Search: collection '${collection}' not found (404), returning empty results`,
  );
  return [];
}
```

**Файл**: `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`

```typescript
// Після рядка 165: додати логування
const results = await vectorStore.search(
  collectionName,
  embedding,
  limit * 2,
  filter,
);

if (results.length === 0) {
  logger.debug("Recall: no results from vector search", {
    project: projectName,
    collection: collectionName,
    query: query.slice(0, 100),
  });
}
```

### Fix #2: Виправити ім'я поля в context enrichment

**Файл**: `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`

```typescript
// Рядок 227: змінити .memories на .results
if (memoriesRes?.data?.results) {
  for (const m of memoriesRes.data.results) {

// Рядок 241: змінити .memories на .results
if (decisionsRes?.data?.results) {
  for (const m of decisionsRes.data.results) {
```

### Fix #3: Обмежити supersede ланцюги

**Файл**: `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`

У методі `detectRelationships` (рядок 728), перевіряти чи target вже superseded іншою memory:

```typescript
// Рядок 748: додати перевірку
if (r.score > 0.85 && existingType === type && !r.payload.supersededBy) {
  relations.push({ ... type: 'supersedes' ... });
}
```

## Blast Radius

### Fix #1 (logging):

- `rag-api/src/services/vector-store.ts` — безпечна зміна, тільки додає логування
- `rag-api/src/services/memory.ts` — безпечна зміна, тільки додає логування

### Fix #2 (field name):

- `mcp-server/src/context-enrichment.ts` — впливає на всі enrichable tools (search_codebase, ask_codebase, explain_code, find_feature, review_code, generate_tests, suggest_implementation, suggest_related_code, check_architecture, context_briefing, run_agent)
- Після виправлення ці tools почнуть отримувати автоматичний контекст з пам'яті

### Fix #3 (supersede chain):

- `rag-api/src/services/memory.ts` — впливає на `remember()` і всі наступні виклики `recall()`
- Існуючі superseded memories залишаться superseded (потрібна міграція для очищення)

## Prevention

1. **Додати observability**: логувати порожні результати пошуку в пам'яті із зазначенням причини (404, no matches, all superseded)
2. **Додати health check**: при старті MCP сервера перевіряти чи існує `{project}_agent_memory` колекція
3. **Тести на integration рівні**: тест що `remember` -> `recall` повертає непорожній результат
4. **Тести на response format**: тест що enrichment правильно парсить response від recall API
5. **Metric для superseded ratio**: якщо більше 50% memories superseded — логувати warning
