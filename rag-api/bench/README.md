# Reka Code-QA / Retrieval Benchmark

A runnable harness that measures **retrieval quality**, **answer quality**, and
**token cost** of the Reka RAG API on a given project. This is the artifact we
publish the headline marketing number from:

> **task success + tokens, with vs without Reka**

Competitors lead with outcome numbers (Augment +80% on 300 PRs, Cursor +12.5%
vs grep, Qodo DeepCodeBench 80%, claude-context 40% token reduction). Today Reka
only has internal MRR / LongMemEval numbers — this harness produces an
external-facing, project-grounded benchmark.

## What it measures

For every item in a dataset it calls three live endpoints:

| Endpoint                      | Used for                                                  |
| ----------------------------- | --------------------------------------------------------- |
| `POST /api/search` (navigate) | retrieval ranking (cross-encoder reranked, graph-boosted) |
| `POST /api/smart-dispatch`    | retrieval ranking (LLM-routed, parallel lookups)          |
| `POST /api/ask`               | the natural-language answer (skippable)                   |

> Note: the dispatch endpoint is `POST /api/smart-dispatch` (the smart-dispatch
> service lives in `rag-api/src/services/smart-dispatch.ts`; there is no
> `/api/context-pack/smart-dispatch` route).

### Metrics

| Metric              | Definition                                                                                                                                                                                                                                | Code                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **recall@k**        | Fraction of `expectedFiles` that appear in the top-k retrieved files. `1.0` = every expected file surfaced.                                                                                                                               | `metrics.ts:recallAtK`                        |
| **MRR**             | `1 / rank` of the first retrieved file matching any `expectedFiles` (1-based). `0` if none found.                                                                                                                                         | `metrics.ts:reciprocalRank`                   |
| **answer-contains** | Fraction of `expectedAnswerContains` substrings present (case-insensitive) in the `/api/ask` answer.                                                                                                                                      | `metrics.ts:answerContainsRate`               |
| **tokens**          | From response metadata (`usage.total_tokens`, `usage.input_tokens+output_tokens`, `tokens`, …) if present; else **estimated** at ~4 chars/token over question + answer + retrieved context. Estimated values are shown with a `~` prefix. | `metrics.ts:extractTokens` / `estimateTokens` |

Both **search** and **smart-dispatch** retrieval are scored separately
(`s.recall`/`s.mrr` vs `d.recall`/`d.mrr`) so you can see which retrieval path
is winning per query.

Metrics that don't apply to an item (e.g. no `expectedFiles`, or no
`expectedAnswerContains`) are reported as `null` / `n/a` and excluded from
aggregate means — they never count as a 0.

**File path matching** is boundary-aware suffix matching: the dataset stores
repo-relative paths (`rag-api/src/middleware/rate-limit.ts`) while the API may
return project- or absolute paths. A retrieved path matches if one path ends
with the other on a `/` segment boundary, so `my-rate-limit.ts` does **not**
match `rate-limit.ts`.

## Prerequisites

- A reachable, **indexed** Reka RAG API. The benchmark queries the
  `{project}_codebase` collection — index the target project first
  (`POST /api/index` or the `index_codebase` MCP tool).
- Node ≥ 18 (uses global `fetch`). Tested on Node 24.
- `ts-node` and `vitest` are already installed in `rag-api/node_modules`.

## Configuration (env vars)

| Var                | Default                 | Meaning                                                        |
| ------------------ | ----------------------- | -------------------------------------------------------------- |
| `REKA_API_URL`     | `http://localhost:3100` | Base URL of the RAG API.                                       |
| `REKA_API_KEY`     | _(none)_                | Sent as `X-Api-Key`. Omit if `ALLOW_ANONYMOUS=true`.           |
| `BENCH_PROJECT`    | `rag`                   | Project name → `X-Project-Name` header + `{project}_codebase`. |
| `BENCH_K`          | `5`                     | k for recall@k / number of results requested.                  |
| `BENCH_TIMEOUT_MS` | `120000`                | Per-request timeout.                                           |
| `BENCH_SKIP_ASK`   | _(unset)_               | Set `1` for retrieval-only (no LLM `/api/ask` cost).           |

## Run it

From the `rag-api` directory (so shared `node_modules` resolves):

```bash
# Convenience script (uses tsx). Pass dataset + flags after `--`.
REKA_API_URL=http://localhost:3100 \
REKA_API_KEY=rk_rag_xxx \
BENCH_PROJECT=rag \
  npm run bench -- bench/datasets/sample.json

# Equivalent explicit invocation (full run: retrieval + answer + tokens)
REKA_API_URL=http://localhost:3100 \
REKA_API_KEY=rk_rag_xxx \
BENCH_PROJECT=rag \
  npx ts-node --transpile-only -P bench/tsconfig.json bench/runner.ts bench/datasets/sample.json

# Retrieval-only (fast, no LLM tokens spent)
BENCH_SKIP_ASK=1 npx ts-node --transpile-only -P bench/tsconfig.json bench/runner.ts bench/datasets/sample.json --no-ask

# Custom output path
... bench/runner.ts bench/datasets/sample.json --out=bench/results/run-2026-06-09.json
```

Or via the bench package script (from `rag-api/bench`):

```bash
cd bench && npm run bench -- datasets/sample.json
```

Output: a printed per-item + overall table, plus a JSON report written to
`bench/results/latest.json` (or `--out=`). The process **exits non-zero if any
item errored**, so CI can gate on it.

## The metric unit tests

`bench/metrics.test.ts` covers `recallAtK`, `reciprocalRank`,
`answerContainsRate`, token extraction/estimation and path matching with
hand-made inputs. It is **outside** the main suite's `src/**` glob, so it neither
runs as part of nor can break `npm test` in `rag-api`. Run it explicitly:

```bash
# from rag-api/
npx vitest run --config bench/vitest.config.ts
# or from rag-api/bench/
npm test
```

Type-check the harness in isolation (does not touch the main build, which
excludes this folder):

```bash
# from rag-api/
npx tsc -p bench/tsconfig.json --noEmit
```

## The seed dataset (`datasets/sample.json`)

12 realistic questions against **this** repo, with verified `expectedFiles` and
`expectedAnswerContains`. Examples:

- _"where is the rate limiter implemented…"_ → `rag-api/src/middleware/rate-limit.ts`
- _"how does memory consolidation work…"_ → `rag-api/src/services/consolidation-agent.ts`
- _"what tools does the MCP server expose…"_ → `mcp-server/src/index.ts`

A dataset item:

```jsonc
{
  "id": "rate-limiter", // stable id (table + JSON key)
  "question": "where is the rate limiter…", // sent verbatim as query/task/question
  "expectedFiles": [
    // optional; repo-relative paths
    "rag-api/src/middleware/rate-limit.ts",
  ],
  "expectedAnswerContains": ["rate", "sliding window"], // optional; case-insensitive
}
```

## Adding a DeepCodeBench-style set

[DeepCodeBench](https://www.qodo.ai/) derives QA pairs from real PRs/commits:
each item is a question grounded in a code change, with the changed files as
ground truth. To build one for a target project:

1. **Mine PRs/commits.** For each merged PR, take the title/description as the
   `question` and the changed source files as `expectedFiles`.
2. **Add answer anchors.** Pull 1–3 distinctive substrings from the PR
   (function name, error message, config key) into `expectedAnswerContains`.
   Keep them specific enough to be meaningful, generic enough to survive
   paraphrasing (the harness lowercases both sides).
3. **Save** as a JSON array at `bench/datasets/<project>-deepcode.json`.
4. **Run** with `BENCH_PROJECT=<project>` pointed at an index of that project.

Tips:

- 50–200 items gives a stable aggregate; the seed set is intentionally tiny.
- Use repo-relative paths in `expectedFiles` (matching is suffix/boundary-based,
  so the leading path root need not match the server's).
- For pure retrieval benchmarking, run with `--no-ask` to skip LLM cost.

## Publishing the "with vs without Reka" number

This harness gives you the **with-Reka** side: recall@k, MRR, answer-contains and
token cost over a dataset. To produce the comparative headline:

1. **With Reka** — run this harness; record `searchRecallAtK`, `searchMrr`,
   `answerContainsRate`, and `totalTokens` from the JSON `overall` block.
2. **Without Reka (baseline)** — run the same dataset through your baseline
   (e.g. plain `grep`/ripgrep over the repo for retrieval, or the same LLM with
   naive full-file/grep context for answers) and record the same metrics +
   token count.
3. **Report the delta**, e.g. _"+X% answer-contains and −Y% tokens vs grep on N
   questions"_, alongside the raw numbers and dataset size so it's reproducible.

The aggregate JSON (`overall`) is the canonical source for these figures; commit
the dataset and the JSON report so the number is auditable.

## The other harnesses under `bench/`

`bench/` is the **single** home for every eval harness in this repo (there is no
second copy under `src/` — see the Subtraction rule in the root `CLAUDE.md`).
Besides the code-QA runner above, it holds two relocated sub-harnesses:

### `bench/eval/` — golden-query + CoIR retrieval benchmark

Self-contained, HTTP-only (talks to the RAG API over the network, imports no live
`src/` service), so it type-checks under `bench/tsconfig.json` alongside the main
runner. This is the harness the **M6 re-baseline (task 3)** drives for code-retrieval
numbers.

```bash
# from rag-api/
npm --prefix bench run eval -- run --project rag --hybrid       # golden queries
npm --prefix bench run eval -- compare before.json after.json   # delta two reports
npm --prefix bench run eval:coir -- --dataset cosqa             # CoIR (CosQA/APPS/StackOverflow)
```

Golden datasets live in `bench/eval/golden-queries.json` (default) and
`bench/eval/golden-queries-v2.json` (larger, pass via `--golden`). CoIR qrels
ground truth is committed at `bench/eval/data/coir/cosqa/qrels-test.json`; the
queries/corpus are downloaded on demand (gitignored). Reports are written to
`bench/eval/results/` (gitignored).

### `bench/tribunal/` — debate-quality (LLM-as-judge) eval

Unlike the retrieval harnesses, this one imports live rag-api services in-process
(`tribunalService`, `llm` via `../../src`), so it is **run with ts-node
`--transpile-only` and excluded from the bench type-check**:

```bash
# from rag-api/
npm --prefix bench run tribunal -- --cases=arch --rounds=1
```

Cases live in `bench/tribunal/tribunal-cases.ts`; scorecards are written to
`bench/tribunal/results/` (gitignored).

> LongMemEval lives elsewhere on purpose: its ingest/benchmark scripts are in
> `rag-api/src/scripts/longmemeval-*.ts` (they import the live indexing/memory
> services directly and run inside the rag-api build), not under `bench/`.
