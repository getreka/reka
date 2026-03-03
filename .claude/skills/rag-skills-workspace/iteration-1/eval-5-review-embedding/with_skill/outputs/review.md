## Code Review: rag-api/src/services/embedding.ts

### Summary
Код загалом добре структурований та відповідає архітектурним патернам проекту (Singleton Service Layer). Є декілька проблем середньої та низької тяжкості, пов'язаних з типізацією, дублюванням логіки, відсутністю валідації вхідних даних, та неповним покриттям тестами.

**Вердикт: Needs changes** -- потрібні зміни для підвищення надійності та усунення дублювання.

---

### Pattern Compliance

- **Service Layer (Singleton)**: PASS -- клас `EmbeddingService` з синглтон-інстансом `export const embeddingService = new EmbeddingService()` повністю відповідає патерну.
- **Project Isolation via Collection Namespacing**: PASS -- сервіс приймає `projectName` через `EmbedOptions` і передає його в кеш.
- **Zod Validation Middleware**: N/A -- це сервіс, а не роут. Валідація входить на рівні роутів.

### ADR Compliance

- **Use BGE-M3 as primary embedding model** (accepted): COMPLIANT -- BGE-M3 є провайдером за замовчуванням, правильні ендпоінти `/embed`, `/embed/batch`, `/embed/full`, `/embed/batch/full`.
- **Qdrant as sole vector database with typed collections** (accepted): COMPLIANT -- сервіс не взаємодіє з Qdrant напряму, лише генерує вектори.

---

### Issues Found

#### 1. **Warning**: Значне дублювання логіки кешування
- **Location**: `embedding.ts:47-65` (embed), `embedding.ts:92-123` (embedWithDetails), `embedding.ts:240-312` (embedBatchWithBGE)
- **Description**: Паттерн "перевірити кеш -> обчислити -> зберегти в кеш" повторюється три рази з двома гілками (session vs basic) кожного разу. Метод `embedWithDetails` фактично повторює логіку `embed` + `embedWithSession` з додаванням `cacheLevel`.
- **Suggestion**: Витягнути спільну логіку кешування в приватний метод, наприклад:
  ```typescript
  private async embedCached(text: string, options?: EmbedOptions): Promise<{ embedding: number[], cacheLevel: EmbeddingResult['cacheLevel'] }> {
    // Unified cache check + compute + store logic
  }
  ```
  Потім `embed()`, `embedWithDetails()` та `embedWithSession()` делегуватимуть до нього.

#### 2. **Warning**: Використання `error: any` замість типізованих помилок
- **Location**: `embedding.ts:194`, `embedding.ts:208`, `embedding.ts:234`, `embedding.ts:308`, `embedding.ts:322`, `embedding.ts:343`
- **Description**: У всіх catch-блоках використовується `error: any`. Це знижує type safety і суперечить тренду проекту на усунення `any` (зафіксовано як tech debt: "~56 'any' types in MCP tool handlers").
- **Suggestion**: Використовувати `unknown` та утиліти для обробки помилок:
  ```typescript
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('BGE-M3 embedding failed', { error: message });
    throw error;
  }
  ```
  Або краще -- використовувати `wrapError()` з `rag-api/src/utils/errors.ts`, який вже є в проекті.

#### 3. **Warning**: Відсутня валідація вхідного тексту
- **Location**: `embedding.ts:47` (embed), `embedding.ts:128` (embedBatch)
- **Description**: Жоден метод не валідує вхідний текст. Порожній рядок, null, або дуже довгий текст пройдуть без помилки і створять непередбачуваний ембедінг або помилку від зовнішнього API.
- **Suggestion**: Додати валідацію на початку публічних методів:
  ```typescript
  if (!text || text.trim().length === 0) {
    throw new Error('Embedding text cannot be empty');
  }
  ```
  Для batch: перевіряти, що масив не порожній і не містить порожніх рядків.

#### 4. **Warning**: Відсутній таймаут для HTTP запитів
- **Location**: `embedding.ts:189`, `embedding.ts:202`, `embedding.ts:230`, `embedding.ts:280`, `embedding.ts:316`, `embedding.ts:329`
- **Description**: Усі `axios.post()` виклики не мають явного таймауту. Якщо BGE-M3/Ollama/OpenAI зависне, запит буде чекати нескінченно. Це особливо критично для batch-запитів з великою кількістю текстів.
- **Suggestion**: Додати таймаут до axios запитів:
  ```typescript
  const response = await axios.post(url, data, { timeout: 30000 }); // 30s
  ```
  Або краще -- створити інстанс axios з налаштуваннями за замовчуванням.

#### 5. **Warning**: `embedBatchFull` та `embedFull` не використовують кешування
- **Location**: `embedding.ts:165-172` (embedFull), `embedding.ts:178-185` (embedBatchFull)
- **Description**: На відміну від `embed` та `embedBatch`, методи `embedFull` та `embedBatchFull` не мають кешування взагалі. Кожний виклик завжди робить HTTP запит. Це може бути проблемою продуктивності, враховуючи, що `embedFull` використовується в `context-pack.ts` та `indexer.ts`.
- **Suggestion**: Додати хоча б базове кешування для dense-частини, або задокументувати чому кешування навмисно відсутнє (наприклад, через sparse вектори, які важко кешувати).

#### 6. **Info**: Жорстко закодована модель OpenAI
- **Location**: `embedding.ts:332`
- **Description**: Модель OpenAI `text-embedding-3-small` жорстко закодована, хоча інші налаштування (URL, ключ) беруться з конфігу.
- **Suggestion**: Додати `OPENAI_EMBEDDING_MODEL` в `Config` interface та використовувати `config.OPENAI_EMBEDDING_MODEL` замість літерала.

#### 7. **Info**: Послідовний кеш-лукап в batch-методі
- **Location**: `embedding.ts:247-269`
- **Description**: В `embedBatchWithBGE` кеш перевіряється послідовно для кожного тексту (`for` loop з `await`). Для великих батчів це може бути повільно.
- **Suggestion**: Використати `Promise.all` для паралельних кеш-перевірок:
  ```typescript
  const cacheResults = await Promise.all(
    texts.map(t => cacheService.getSessionEmbedding(t, options))
  );
  ```

#### 8. **Info**: Провайдер встановлюється лише в конструкторі
- **Location**: `embedding.ts:40-42`
- **Description**: Оскільки `EmbeddingService` є синглтоном, провайдер зчитується один раз при імпорті модуля. Динамічна зміна `config.EMBEDDING_PROVIDER` не вплине на сервіс без перезапуску. Це нормальна поведінка для синглтона, але варто задокументувати.
- **Suggestion**: Додати коментар або метод для тестів:
  ```typescript
  /** @internal For testing only */
  _setProvider(provider: string) { this.provider = provider; }
  ```

---

### Dependency Impact

- **31 downstream файлів** залежать від `embeddingService` (imports з 20+ сервісів та роутів).
- **Критичні споживачі**: `indexer.ts` (використовує `embedBatch`, `embedBatchFull`, `embedFull`, `embed`), `context-pack.ts` (`embedFull`, `embed`), `search.ts` (основний пошук), `memory.ts` (`embed`, `embedBatch`).
- **Публічний API стабільний**: Зміни, описані вище, не вплинуть на сигнатури публічних методів, тому downstream файли не потребують модифікації.

---

### Test Coverage

**Існуючі тести** (`rag-api/src/__tests__/services/embedding.test.ts`):
- embed (basic caching): cache hit, cache miss -- COVERED
- embed (session-aware caching): session hit, session miss -- COVERED
- embedBatch (BGE-M3): partial cache, full cache -- COVERED
- embedFull: dense + sparse from BGE-M3 -- COVERED
- error handling: network failure -- COVERED

**Відсутні тести**:
1. `embedWithDetails` -- не протестований жодний сценарій (ні session, ні basic, ні cache hit/miss)
2. `embedBatchFull` -- не протестований
3. `embedBatch` для non-BGE providers (Ollama, OpenAI) -- не протестований fallback через sequential `embed()`
4. `warmSessionCache` -- не протестований (делегує до cacheService, але навіть делегація не перевірена)
5. `computeEmbedding` -- Ollama та OpenAI провайдери не протестовані
6. Edge cases: порожній текст, порожній batch, дуже довгий текст
7. `embedFullWithBGE` та `embedBatchFullWithBGE` -- error handling не перевірений

---

### Tech Debt

**Існуючий tech debt, що стосується файлу**:
- "Low test coverage in rag-api" (medium) -- embedding.ts покритий частково, відсутні тести для `embedWithDetails`, `embedBatchFull`, Ollama/OpenAI провайдерів.

**Новий tech debt, який варто зафіксувати**:
- Дублювання cache logic (Warning #1) -- середній вплив на maintainability
- Відсутність input validation (Warning #3) -- потенційний runtime error при некоректних даних
- Відсутність HTTP timeout (Warning #4) -- ризик зависання при недоступності зовнішніх сервісів
- Hardcoded OpenAI model (Info #6) -- низький вплив, але порушує consistency з іншими конфігами

**Усунений tech debt**: немає.
