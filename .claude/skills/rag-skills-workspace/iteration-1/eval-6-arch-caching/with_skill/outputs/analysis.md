# Architecture Analysis: Кешування Embeddings — Redis L2 vs In-Memory LRU

## Поточний стан

### Існуючі ADR по кешуванню

**Жодного ADR безпосередньо про стратегію кешування embeddings не записано.** Це рішення було реалізовано "де-факто" без формального ADR.

### Поточна реалізація (cache.ts + embedding.ts)

Зараз працює **3-рівневий Redis-based кеш**:

| Рівень       | Ключ                          | TTL    | Призначення                |
| ------------ | ----------------------------- | ------ | -------------------------- |
| L1 (Session) | `sess:{sessionId}:emb:{hash}` | 30 хв  | Гарячий кеш поточної сесії |
| L2 (Project) | `proj:{project}:emb:{hash}`   | 1 год  | Кеш на рівні проекту       |
| L3 (Global)  | `glob:emb:{hash}`             | 24 год | Спільний кеш між проектами |

**Механізми:**

- Каскадний lookup: L1 -> L2 -> L3 -> compute
- Promotion: при L2 hit — копіюється в L1; при L3 hit — в L1+L2
- Write-through: нові embeddings записуються одразу в усі 3 рівні (Promise.all)
- Batch: embedBatchWithBGE() перевіряє кеш по кожному тексту, потім batch-обчислює лише некешовані
- Session warming: при старті сесії pre-warm з попередньої сесії або L2/L3

### Що НЕ існує

- **In-memory LRU кеш** — повністю відсутній. Усі звернення йдуть в Redis.
- **Prometheus метрики не підключені** — `embeddingCacheHits`/`embeddingCacheMisses` в metrics.ts існують, але НЕ інкрементуються з cache.ts (використовуються лише Redis-based session stats).

### Пов'язані рішення (recalled)

- Sprint 1 Performance (Feb 2026): збільшено TTL з 3 хв до 30 хв, що скоротило embedding calls на ~40%
- Graph expansion кешується в Redis з 5-хв TTL
- Ідентифіковано що serial cache checks в batch потребують паралелізації

### Інфраструктура

- Redis 7 Alpine в Docker, порт 6380:6379, `appendonly yes`
- Embedding: BGE-M3 сервер (Python, порт 8080), 1024-dim вектори
- Один вектор = 1024 \* 4 байти = ~4 KB dense

---

## Опції

### Option A: Додати In-Memory LRU як L0 перед Redis

**Суть:** Додати process-level LRU кеш (наприклад, `lru-cache` npm) як найшвидший рівень. L0 (memory) -> L1 (Redis session) -> L2 (Redis project) -> L3 (Redis global).

**Pros:**

- Латентність ~0ms vs ~1-2ms для Redis round-trip на localhost
- Нуль мережевих витрат для hot path (повторні запити в рамках одного процесу)
- Batch операції стають миттєвими для вже бачених текстів
- Просто реалізувати: `lru-cache` має стабільний API, ~50 рядків коду
- Prometheus метрики можна одразу підключити до L0 hits/misses
- Відповідає патерну Service Layer (Singleton) — один процес = один LRU

**Cons:**

- Дублювання даних (RAM + Redis) — кожний embedding ~4KB, 1000 записів = ~4MB
- Не шариться між процесами (якщо запустити кілька rag-api instances)
- Cold start — порожній після перезапуску процесу (але Redis прогріває)
- Потребує maxSize/maxAge конфігурації — ризик OOM при неправильному налаштуванні
- Інвалідація складніша — Redis TTL не синхронізується з LRU eviction

**Fits patterns:**

- Service Layer (Singleton) — LRU живе як private field в CacheService
- Не порушує жодного існуючого ADR

**Conflicts with:** Нічого

### Option B: Збільшити Redis TTL та оптимізувати Redis доступ

**Суть:** Замість додавання нового рівня, оптимізувати існуючий Redis: збільшити TTL, batch pipeline операції, використати Redis pipelining для batch cache checks.

**Pros:**

- Нульова додаткова складність — працює з існуючим кодом
- Шариться між процесами "безкоштовно"
- Redis пам'ять контролюється maxmemory + eviction policy
- Batch pipeline: одна Redis команда замість N окремих get() в embedBatchWithBGE()
- Менше ризику OOM в Node.js process

**Cons:**

- Мінімальна різниця в латентності: Redis localhost ~1-2ms vs LRU ~0ms
- Batch pipelining вже частково є (Promise.all на set), але get — серійний
- TTL вже збільшений з 3 до 30 хв (Sprint 1) — подальше збільшення може давати stale embeddings при зміні моделі
- Не вирішує проблему hot-path latency для дуже частих запитів

**Fits patterns:**

- Service Layer (Singleton) — без змін
- Існуючий L1/L2/L3 дизайн в cache.ts

**Conflicts with:** Нічого

### Option C: Hybrid — In-Memory L0 + Redis Pipeline Optimization

**Суть:** Додати невеликий in-memory LRU (L0, 500-2000 записів) І оптимізувати Redis pipeline для batch операцій.

**Pros:**

- Hot path (~0ms) для найчастіших embedding запитів (пошукові queries повторюються)
- Redis pipeline для batch cold path
- Обмежений maxSize контролює RAM usage
- Prometheus метрики на L0 дають visibility в real hot path
- Кращий fallback: L0 miss -> Redis pipeline (1 round-trip замість N)

**Cons:**

- Більше складності ніж A або B окремо
- Два механізми інвалідації (LRU eviction + Redis TTL)
- Потребує більше тестування

**Fits patterns:**

- Service Layer (Singleton)
- Не порушує ADR

**Conflicts with:** Нічого

---

## Рекомендація

**Option C (Hybrid)** — найкращий баланс між performance та maintenance:

1. **In-Memory LRU (L0):** Додати `lru-cache` з `maxSize: 2000` та `ttl: 30min` (синхронно з SESSION_EMBEDDING TTL). Один embedding ~4KB \* 2000 = ~8MB RAM — допустимо для Node.js процесу.

2. **Redis Pipeline:** Замінити серійні `getSessionEmbedding()` виклики в `embedBatchWithBGE()` на `pipeline.get()` batch — один round-trip замість N.

3. **Prometheus:** Підключити `embeddingCacheHits`/`embeddingCacheMisses` з metrics.ts до реальних cache операцій, з labels `{level: "l0"|"l1"|"l2"|"l3"}`.

**Чому не тільки A (LRU):** Redis вже працює, pipeline оптимізація для batch дає більше ніж LRU для indexing (великі batch, рідко повторюються).

**Чому не тільки B (Redis only):** Для пошукових запитів (recall, search) ті самі embedding генеруються десятки разів за сесію — L0 дасть ~0ms замість ~1-2ms, що накопичується.

**Оцінка впливу:**

- Hot path latency: -1-2ms per embedding lookup
- Batch indexing: -50-200ms per batch (pipeline vs serial Redis)
- RAM: +8MB max (для L0 LRU, 2000 entries)
- Код: ~100 рядків в cache.ts + ~20 в embedding.ts

---

## Наступні кроки

Після підтвердження рішення буде записано:

- **ADR:** "Multi-level embedding cache with in-memory L0 and Redis L1-L3"
- **Pattern:** оновлення Service Layer з LRU cache convention
- **Tech Debt** (якщо потрібно): Prometheus метрики не підключені до cache — записати як medium-impact debt
