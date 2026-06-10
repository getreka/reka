# Як працює система Memory Governance

## Огляд

Система Memory Governance реалiзує двотiрну модель зберiгання пам'ятi: **quarantine** (карантин) та **durable** (стiйке сховище). Основна iдея -- автоматично згенерованi пам'ятi не потрапляють одразу в основне сховище, а проходять через карантин, звiдки їх можна промотувати або вiдхилити.

## Основнi файли

| Файл                                        | Роль                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `rag-api/src/services/memory-governance.ts` | Головний сервiс governance: ingest, promote, reject, recall, maintenance |
| `rag-api/src/services/memory.ts`            | Базовий сервiс пам'ятi: remember, recall з aging, list, merge            |
| `rag-api/src/services/quality-gates.ts`     | Quality gates: typecheck, test, blast-radius перед promotion             |
| `rag-api/src/services/feedback.ts`          | Збiр фiдбеку по пам'ятi: accurate/outdated/incorrect                     |
| `rag-api/src/routes/memory.ts`              | HTTP API ендпоiнти для всiх операцiй                                     |
| `mcp-server/src/tools/memory.ts`            | MCP тули: promote_memory, review_memories, memory_maintenance            |
| `mcp-server/src/context-enrichment.ts`      | Enricher -- викликає recall-durable для контекстного збагачення          |
| `rag-api/src/utils/validation.ts`           | Zod-схема promoteMemorySchema                                            |

## Потiк даних (Flow)

### 1. Ingestion (запис пам'ятi) -- `MemoryGovernanceService.ingest()`

```
POST /api/memory
    |
    +--> source.startsWith('auto_')?
          |
          YES --> memoryGovernance.ingest()
          |        |
          |        +--> confidence < adaptiveThreshold?
          |        |      YES --> skip (повертає stub з metadata.skipped=true)
          |        |      NO  --> зберiгає в {project}_memory_pending (quarantine)
          |
          NO --> memoryService.remember()
                    |
                    +--> зберiгає в {project}_agent_memory (durable)
```

**Ключовий момент**: Маршрутизацiя вiдбувається за полем `source`. Якщо source починається з `auto_` (наприклад, `auto_conversation`, `auto_pattern`, `auto_feedback`), пам'ять потрапляє в карантин. Якщо source вiдсутнiй або `manual` -- пам'ять йде прямо в durable.

### 2. Adaptive Confidence Threshold -- `getAdaptiveThreshold()`

Файл: `rag-api/src/services/memory-governance.ts:39-85`

Система динамiчно регулює порiг прийняття auto-пам'ятей на основi iсторiї промоцiй:

- Рахує кiлькiсть промотованих (durable з `originalSource=auto_*`) та pending (quarantine)
- Формула: `threshold = 0.8 - successRate * 0.4`
- Дiапазон: [0.4, 0.8], дефолт 0.5
- Кешується на 30 хвилин per project
- Високий success rate (багато промоцiй) -> нижчий порiг (приймає бiльше)
- Високий rejection rate -> вищий порiг (фiльтрує бiльше)

Якщо `confidence < threshold`, пам'ять вiдкидається без збереження (повертається stub з `metadata.skipped=true`).

### 3. Qdrant колекцiї

| Колекцiя                   | Тiр        | Призначення                               |
| -------------------------- | ---------- | ----------------------------------------- |
| `{project}_agent_memory`   | Durable    | Валiдованi, ручнi, та промотованi пам'ятi |
| `{project}_memory_pending` | Quarantine | Авто-згенерованi пам'ятi на перевiрцi     |

Генерацiя назв:

```typescript
private getQuarantineCollection(projectName: string): string {
  return `${projectName}_memory_pending`;
}
private getDurableCollection(projectName: string): string {
  return `${projectName}_agent_memory`;
}
```

### 4. Promotion (промоцiя) -- `MemoryGovernanceService.promote()`

Файл: `rag-api/src/services/memory-governance.ts:168-231`

```
promote(projectName, memoryId, reason, evidence?, gateOptions?)
    |
    +--> runGates? --> qualityGates.runGates()
    |                    +--> typeCheckGate (tsc --noEmit, 30s timeout)
    |                    +--> testGate (vitest/jest related tests, 60s timeout)
    |                    +--> blastRadiusGate (graph traversal, warn >20 files)
    |                    +--> if !passed --> throw Error
    |
    +--> scroll quarantine collection by memoryId
    +--> delete from quarantine
    +--> memoryService.remember() --> save to durable with enriched metadata:
            - validated: true
            - promotedAt: timestamp
            - promoteReason: 'human_validated' | 'pr_merged' | 'tests_passed'
            - promoteEvidence: string
            - originalSource: auto_*
            - originalConfidence: number
```

**Три причини для промоцiї (PromoteReason)**:

- `human_validated` -- людина пiдтвердила
- `pr_merged` -- PR було змержено
- `tests_passed` -- тести пройшли

### 5. Rejection -- `MemoryGovernanceService.reject()`

Файл: `rag-api/src/services/memory-governance.ts:236-248`

Простий delete з quarantine колекцiї.

### 6. Recall (пошук пам'ятей)

Три рiвнi recall:

| Метод                                 | Колекцiя                   | Використання                         |
| ------------------------------------- | -------------------------- | ------------------------------------ |
| `memoryService.recall()`              | `{project}_agent_memory`   | Загальний recall (MCP `recall` tool) |
| `memoryGovernance.recallDurable()`    | `{project}_agent_memory`   | Context enrichment (MCP enricher)    |
| `memoryGovernance.recallQuarantine()` | `{project}_memory_pending` | Review UI                            |

**Важливо**: Context enrichment (автоматичне збагачення запитiв) використовує ТIЛЬКИ `recall-durable`. Це означає, що неперевiренi авто-пам'ятi НЕ впливають на контекст iнших iнструментiв.

Файл `mcp-server/src/context-enrichment.ts:196-221` -- enricher робить паралельний recall:

- Загальнi пам'ятi (type: "all", limit: maxAutoRecall) з `/api/memory/recall-durable`
- Рiшення (type: "decision", limit: 2) з `/api/memory/recall-durable`

### 7. Memory Aging (старiння пам'ятей)

Файл: `rag-api/src/services/memory.ts:167-190`

При recall з durable колекцiї застосовується score decay:

- Пам'ятi старше 30 днiв без валiдацiї/промоцiї отримують штраф
- Decay: 5% за кожнi 30 днiв пiсля перших 30
- Максимальний штраф: 25%
- Валiдованi та промотованi пам'ятi НЕ деградують
- Superseded пам'ятi (є `supersededBy`) фiльтруються повнiстю

```typescript
const periodsOld = Math.floor(ageMs / THIRTY_DAYS) - 1;
const decay = Math.min(0.25, periodsOld * 0.05);
score *= 1 - decay;
```

### 8. Feedback-Driven Maintenance

Файл: `rag-api/src/services/memory-governance.ts:333-425`

Автоматичне обслуговування на основi фiдбеку:

**Auto-promote** (`autoPromoteByFeedback`):

- Збирає feedback counts через `feedbackService.getMemoryFeedbackCounts()`
- Якщо пам'ять має 3+ "accurate" фiдбеки -> автоматична промоцiя з reason `human_validated`

**Auto-prune** (`autoPruneByFeedback`):

- Якщо пам'ять має 2+ "incorrect" фiдбеки -> видалення
- Спочатку намагається видалити з quarantine, потiм з durable

**runFeedbackMaintenance** запускає обидвi операцiї паралельно.

API: `POST /api/memory/maintenance`
MCP: `memory_maintenance` tool

### 9. Quality Gates (перевiрка якостi)

Файл: `rag-api/src/services/quality-gates.ts`

Три gate, якi можна запустити перед промоцiєю:

| Gate           | Дiя                                  | Timeout | Fail behavior      |
| -------------- | ------------------------------------ | ------- | ------------------ |
| `typecheck`    | `npx tsc --noEmit`                   | 30s     | Blocks promotion   |
| `test`         | `npx vitest/jest --findRelatedTests` | 60s     | Blocks promotion   |
| `blast_radius` | Graph traversal (3 hops)             | -       | Warns if >20 files |

Quality gates можна пропустити через `skipGates` масив.

## Компоненти та патерни

### Архiтектурний патерн: Memory Dual-Tier Governance

```
                    ┌──────────────────────┐
                    │    POST /api/memory   │
                    └──────────┬───────────┘
                               │
                    source.startsWith('auto_')?
                      /                    \
                    YES                     NO
                     |                       |
            ┌────────▼────────┐   ┌──────────▼──────────┐
            │   Adaptive      │   │  memoryService       │
            │   Threshold     │   │  .remember()         │
            │   Check         │   └──────────┬───────────┘
            └────────┬────────┘              │
              conf >= threshold?             │
               /         \                   │
             YES          NO                 │
              |            |                 │
    ┌─────────▼─┐   ┌─────▼──────┐   ┌──────▼──────────┐
    │ Quarantine │   │   Skip     │   │    Durable      │
    │ _pending   │   │ (stub)     │   │ _agent_memory   │
    └─────┬──┬──┘   └────────────┘   └──────▲──────────┘
          │  │                               │
    ┌─────┘  └────────┐                      │
    │                  │                     │
  review          feedback                promote
  (list)        (3+ accurate)     (human/pr/tests)
    │              │                        │
    │              └───────────┐            │
    │                          │            │
    └──────── promote() ──────►├────────────┘
              reject() ────────X (delete)
```

### Prometheus Metrics

Файл: `rag-api/src/utils/metrics.ts:270-275`

```typescript
export const memoryGovernanceTotal = new Counter({
  name: "rag_memory_governance_total",
  help: "Memory governance operations",
  labelNames: ["operation", "tier", "project"],
});
```

Operations tracked: `ingest`, `promote`, `reject`, `prune`
Tiers: `durable`, `quarantine`

## API Endpoints

| Method | Path                         | Description                           |
| ------ | ---------------------------- | ------------------------------------- |
| POST   | `/api/memory`                | Ingest (routes via governance)        |
| POST   | `/api/memory/recall`         | Recall from durable                   |
| POST   | `/api/memory/recall-durable` | Recall durable only (for enrichment)  |
| POST   | `/api/memory/promote`        | Promote quarantine -> durable         |
| GET    | `/api/memory/quarantine`     | List quarantine for review            |
| POST   | `/api/memory/maintenance`    | Run feedback-driven maintenance       |
| PATCH  | `/api/memory/:id/validate`   | Validate/reject auto-extracted memory |
| GET    | `/api/memory/unvalidated`    | List unvalidated memories             |

## MCP Tools

| Tool                 | Description                               |
| -------------------- | ----------------------------------------- |
| `remember`           | Store memory (manual -> durable)          |
| `recall`             | Semantic search in durable                |
| `promote_memory`     | Promote quarantine -> durable with reason |
| `review_memories`    | List quarantine memories for review       |
| `validate_memory`    | Validate/reject auto-extracted memory     |
| `memory_maintenance` | Run auto-promote + auto-prune             |
| `run_quality_gates`  | Run typecheck/test/blast_radius gates     |

## Резюме

Система Memory Governance забезпечує якiсть пам'ятей через:

1. **Розподiл на тiри** -- manual -> durable, auto -> quarantine
2. **Адаптивний порiг** -- динамiчний confidence threshold [0.4-0.8] з iсторiї промоцiй
3. **Промоцiя з причиною** -- human_validated / pr_merged / tests_passed
4. **Quality gates** -- опцiональна перевiрка (tsc + tests + blast radius) перед промоцiєю
5. **Iзоляцiя enrichment** -- контекстне збагачення використовує ТIЛЬКИ durable
6. **Старiння** -- неперевiренi пам'ятi деградують на 5%/мiсяць (макс 25%)
7. **Feedback maintenance** -- автопромоцiя (3+ accurate) та автовидалення (2+ incorrect)
