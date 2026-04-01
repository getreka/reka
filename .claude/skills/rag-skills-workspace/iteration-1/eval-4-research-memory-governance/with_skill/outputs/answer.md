# Як працює система Memory Governance

## Огляд

Memory Governance -- це двотиерна система управління пам'яттю агента, яка розділяє спогади (memories) на **durable** (довготривалі, перевірені) та **quarantine** (карантинні, непідтверджені). Основна мета -- забезпечити якість знань, що зберігаються в пам'яті агента.

## Потік даних

```
Новий memory
    |
    ├── source = manual/undefined → durable ({project}_agent_memory)
    │       ↓
    │   memoryService.remember() → Qdrant
    │
    └── source = auto_* → перевірка adaptive threshold
            |
            ├── confidence < threshold → скіп (не зберігається)
            └── confidence >= threshold → quarantine ({project}_memory_pending)
                    |
                    ├── promote (human_validated | pr_merged | tests_passed)
                    │       → видалення з quarantine
                    │       → запис в durable через memoryService.remember()
                    │       → опціональні quality gates перед промоушеном
                    │
                    ├── reject → видалення з quarantine
                    │
                    └── auto-maintenance (feedback-driven)
                            ├── 3+ accurate feedback → auto-promote
                            └── 2+ incorrect feedback → auto-prune
```

## Ключові компоненти

### 1. Основний сервіс: `MemoryGovernanceService`

**Файл:** `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts`

Клас `MemoryGovernanceService` (рядки 22-426) -- це singleton, що експортується як `memoryGovernance`.

#### Колекції Qdrant

- `{project}_memory_pending` -- карантин для автоматично згенерованих спогадів
- `{project}_agent_memory` -- довготривале сховище перевірених спогадів

#### Методи

| Метод                      | Рядки   | Опис                                                                                             |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `getAdaptiveThreshold()`   | 39-85   | Обчислює адаптивний поріг confidence [0.4, 0.8]. Високий success rate промоушенів → нижчий поріг |
| `ingest()`                 | 91-163  | Маршрутизація: manual → durable, auto\_\* → quarantine (якщо confidence >= threshold)            |
| `promote()`                | 168-231 | Переміщення з quarantine → durable. Опціональний запуск quality gates                            |
| `reject()`                 | 236-248 | Видалення з quarantine                                                                           |
| `recallDurable()`          | 253-255 | Пошук тільки по durable (для enrichment)                                                         |
| `recallQuarantine()`       | 260-294 | Пошук по quarantine (для review)                                                                 |
| `listQuarantine()`         | 299-329 | Список карантинних спогадів (для UI)                                                             |
| `autoPromoteByFeedback()`  | 333-362 | Авто-промоушен при 3+ accurate feedback                                                          |
| `autoPruneByFeedback()`    | 368-405 | Авто-видалення при 2+ incorrect feedback                                                         |
| `runFeedbackMaintenance()` | 410-425 | Виконання auto-promote + auto-prune в одному проході                                             |

### 2. Adaptive Confidence Threshold

Порогове значення для автоматичних спогадів обчислюється динамічно на основі історії промоушенів:

```typescript
// memory-governance.ts:76
const threshold = Math.max(0.4, Math.min(0.8, 0.8 - successRate * 0.4));
```

- Діапазон: [0.4, 0.8], default = 0.5
- Високий success rate (багато promoted) → нижчий поріг (приймати більше)
- Низький success rate (багато rejected/pending) → вищий поріг
- Кешується на 30 хвилин per project

### 3. Quality Gates (перед промоушеном)

**Файл:** `/home/ake/shared-ai-infra/rag-api/src/services/quality-gates.ts`

При виклику `promote()` з `runGates: true` виконуються перевірки:

| Gate           | Обов'язковий | Опис                                                       |
| -------------- | ------------ | ---------------------------------------------------------- |
| `typecheck`    | Так          | `tsc --noEmit` (timeout 30s)                               |
| `test`         | Так          | Виявлення jest/vitest, запуск related тестів (timeout 60s) |
| `blast_radius` | Ні (info)    | Аналіз транзитивних залежностей через graph store          |

Якщо quality gates не проходять, промоушен блокується з помилкою.

### 4. Інтеграція з Context Enrichment

**Файл:** `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`

Ключове правило: **enrichment використовує тільки durable memories**. Це гарантує, що непідтверджені карантинні спогади не потрапляють в автоматичний контекст.

```typescript
// context-enrichment.ts:198-199
// Виклик /api/memory/recall-durable -- тільки перевірені спогади
ctx.api.post("/api/memory/recall-durable", { ... })
```

### 5. API Routes

**Файл:** `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`

| Route                        | Метод | Рядки   | Опис                                                   |
| ---------------------------- | ----- | ------- | ------------------------------------------------------ |
| `/api/memory`                | POST  | 27-56   | Створення memory; auto\_\* source → governance routing |
| `/api/memory/recall-durable` | POST  | 185-197 | Пошук тільки по durable (для enrichment)               |
| `/api/memory/promote`        | POST  | 203-215 | Промоушен quarantine → durable                         |
| `/api/memory/quarantine`     | GET   | 221-227 | Список карантинних спогадів для review                 |
| `/api/memory/maintenance`    | POST  | 358-362 | Feedback-driven maintenance                            |

### 6. MCP Tools

**Файл:** `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts`

| Tool                 | Рядки   | Опис                                        |
| -------------------- | ------- | ------------------------------------------- |
| `promote_memory`     | 361-401 | Промоушен з reason + optional quality gates |
| `review_memories`    | 307-358 | Перегляд карантинних спогадів               |
| `validate_memory`    | 276-305 | Валідація/відхилення auto-extracted memory  |
| `memory_maintenance` | 448-485 | Автоматичний maintenance на основі feedback |
| `run_quality_gates`  | 403-446 | Запуск quality gates вручну                 |

### 7. Метрики

**Файл:** `/home/ake/shared-ai-infra/rag-api/src/utils/metrics.ts` (рядки 270-275)

Prometheus counter `memory_governance_total` з labels:

- `operation`: ingest, promote, reject, prune
- `tier`: durable, quarantine
- `project`: назва проекту

### 8. Validation Schemas

**Файл:** `/home/ake/shared-ai-infra/rag-api/src/utils/validation.ts` (рядки 134-142)

```typescript
export const promoteMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  memoryId: z.string().min(1),
  reason: z.enum(["human_validated", "pr_merged", "tests_passed"]),
  evidence: z.string().max(2000).optional(),
  runGates: z.boolean().default(false),
  projectPath: z.string().optional(),
  affectedFiles: z.array(z.string()).optional(),
});
```

## Зв'язки між файлами

```
memory-governance.ts
    ├── imports → memory.ts (MemoryService.remember, recall)
    ├── imports → vector-store.ts (upsert, delete, scroll)
    ├── imports → embedding.ts (embed)
    ├── imports → quality-gates.ts (runGates)
    ├── imports → feedback.ts (getMemoryFeedbackCounts)
    └── imports → metrics.ts (memoryGovernanceTotal)

routes/memory.ts
    ├── imports → memory-governance.ts (ingest, promote, recallDurable, listQuarantine, runFeedbackMaintenance)
    └── imports → memory.ts (remember, recall, list, ...)

mcp-server/tools/memory.ts
    └── HTTP calls → routes/memory.ts (POST /api/memory/promote, GET /api/memory/quarantine, POST /api/memory/maintenance)

context-enrichment.ts
    └── HTTP calls → routes/memory.ts (POST /api/memory/recall-durable) -- тільки durable!
```

## Патерн: Memory Dual-Tier Governance

Зафіксований як архітектурний патерн:

1. **Ingest**: manual → durable, auto → quarantine
2. **Recall**: recall() шукає по обох тирах, recall-durable() -- тільки durable
3. **Context enrichment** використовує recall-durable only
4. **Promote**: quarantine → durable з reason + optional quality gates
5. **Auto-maintenance**: feedback-driven promote/prune
