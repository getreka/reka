/**
 * memory-tool-adapter.ts
 *
 * Backend for Anthropic's client-side memory tool (`memory_20250818`) backed by
 * Reka's RAG memory API. Claude (Opus/Sonnet 4.x) is RL-trained to call the
 * `memory` tool *unprompted* to persist context across turns; this adapter lets
 * those calls land in Reka's durable memory store instead of a throwaway local
 * filesystem — closing Reka's "Claude won't call our custom remember() tool"
 * adoption gap.
 *
 * The memory tool models a `/memories` directory tree and issues six commands:
 *   view | create | str_replace | insert | delete | rename
 * over file paths. We map each command onto Reka's existing memory endpoints
 * (via the shared {@link ApiClient}):
 *
 *   create      -> POST /api/memory            (remember; path stored as tag + relatedTo)
 *   insert      -> POST /api/memory            (remember; appended fragment at a path)
 *   view        -> POST /api/memory/recall  +  GET /api/memory/list?tag=<path>
 *                  (list a directory by path-prefix, or read a file by exact path)
 *   str_replace -> recall(path) + remember(new) + DELETE old   (supersede in place)
 *   delete      -> DELETE /api/memory/:id       (forget every memory at the path)
 *   rename      -> recall(old) + remember(new path) + DELETE old   (supersede w/ new tag)
 *
 * A "path" (e.g. `/memories/auth/decisions.md`) has no first-class column in
 * Reka, so we encode it as BOTH a tag (`mem:path=/memories/auth/decisions.md`)
 * for exact lookup AND `relatedTo` for human readability. Directory listings
 * use a tag *prefix* match performed client-side over the project's memory list.
 *
 * ── Governance (M2) ──
 * Every write is attributed with `metadata.source = 'auto_memory_tool'` and NO
 * confidence, so memoryGovernance.ingest always QUARANTINES it (and never
 * threshold-drops it — create succeeds, as memory_20250818 expects). Reads at a
 * path merge durable + quarantine (read-your-writes), but quarantined writes
 * stay invisible to semantic `recall` until a human/gate promotes them — that
 * is the governance gate this adapter is wired through.
 *
 * ── Wiring into @anthropic-ai/sdk (betaMemoryTool / BetaAbstractMemoryTool) ──
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
 *   import { createApiClient } from './api-client.js';
 *   import { MemoryToolAdapter } from './memory-tool-adapter.js';
 *
 *   const api = createApiClient(RAG_API_URL, PROJECT_NAME, PROJECT_PATH, REKA_API_KEY);
 *   const adapter = new MemoryToolAdapter(api, PROJECT_NAME);
 *
 *   // betaMemoryTool takes one handler per command; the adapter exposes the
 *   // exact { [command]: (cmd) => Promise<string> } shape it expects:
 *   const memoryTool = betaMemoryTool(adapter.toHandlers());
 *
 *   const client = new Anthropic();
 *   await client.beta.messages.toolRunner({
 *     model: 'claude-opus-4-8',
 *     max_tokens: 1024,
 *     messages: [{ role: 'user', content: 'Remember that we use BGE-M3 (1024d).' }],
 *     tools: [memoryTool],
 *     betas: ['context-management-2025-06-27'],
 *   });
 *
 * Alternatively, subclass-style (BetaAbstractMemoryTool): forward each abstract
 * method to `adapter.handle(command)` — e.g. `view(cmd) { return adapter.handle(cmd); }`.
 *
 * NOTE: This module has NO dependency on @anthropic-ai/sdk — it defines its own
 * structurally-identical `MemoryCommand` union so mcp-server stays dependency-light
 * and `tsc` passes without the SDK installed. The handler return type
 * (`Promise<string>`) matches what `betaMemoryTool`'s handlers expect.
 */

import type { ApiClient } from "./api-client.js";

// ── memory_20250818 command shapes (structurally identical to the Anthropic SDK's
//    BetaMemoryTool20250818Command union; redeclared to avoid an SDK dependency) ──

export interface MemoryViewCommand {
  command: "view";
  /** Path to directory or file to view (e.g. "/memories" or "/memories/auth.md"). */
  path: string;
  /** Optional [start, end] line range when viewing a file. */
  view_range?: number[];
}

export interface MemoryCreateCommand {
  command: "create";
  /** Content to write to the file. */
  file_text: string;
  /** Path where the file should be created. */
  path: string;
}

export interface MemoryStrReplaceCommand {
  command: "str_replace";
  /** Text to search for and replace. */
  old_str: string;
  /** Text to replace with. */
  new_str: string;
  /** Path to the file where text should be replaced. */
  path: string;
}

export interface MemoryInsertCommand {
  command: "insert";
  /** Line number where text should be inserted. */
  insert_line: number;
  /** Text to insert at the specified line. */
  insert_text: string;
  /** Path to the file where text should be inserted. */
  path: string;
}

export interface MemoryDeleteCommand {
  command: "delete";
  /** Path to the file or directory to delete. */
  path: string;
}

export interface MemoryRenameCommand {
  command: "rename";
  /** Current path of the file or directory. */
  old_path: string;
  /** New path for the file or directory. */
  new_path: string;
}

export type MemoryCommand =
  | MemoryViewCommand
  | MemoryCreateCommand
  | MemoryStrReplaceCommand
  | MemoryInsertCommand
  | MemoryDeleteCommand
  | MemoryRenameCommand;

/** Per-command handler map, shaped for `betaMemoryTool(handlers)`. */
export type MemoryToolHandlers = {
  view: (cmd: MemoryViewCommand) => Promise<string>;
  create: (cmd: MemoryCreateCommand) => Promise<string>;
  str_replace: (cmd: MemoryStrReplaceCommand) => Promise<string>;
  insert: (cmd: MemoryInsertCommand) => Promise<string>;
  delete: (cmd: MemoryDeleteCommand) => Promise<string>;
  rename: (cmd: MemoryRenameCommand) => Promise<string>;
};

/** Tag prefix used to encode a memory-tool path as a Reka tag. */
export const PATH_TAG_PREFIX = "mem:path=";

/** Minimal shape of a Reka memory record we read back. */
interface RekaMemory {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  createdAt?: string;
}

/**
 * Adapts `memory_20250818` tool calls onto Reka's RAG memory API.
 *
 * Stateless apart from the injected {@link ApiClient} + project name, so a single
 * instance can serve an entire agent session.
 */
export class MemoryToolAdapter {
  constructor(
    private readonly api: ApiClient,
    private readonly projectName: string,
  ) {}

  /** Encode a memory-tool path into the Reka tag used for exact lookups. */
  private pathTag(path: string): string {
    return `${PATH_TAG_PREFIX}${this.normalizePath(path)}`;
  }

  /** Normalize a path: ensure a single leading slash, strip a trailing slash. */
  private normalizePath(path: string): string {
    const p = ("/" + path).replace(/\/+/g, "/");
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  }

  /**
   * Single entry point: dispatch a memory_20250818 command to the matching
   * handler and return the tool-result string the memory tool expects.
   */
  async handle(command: MemoryCommand): Promise<string> {
    switch (command.command) {
      case "view":
        return this.view(command);
      case "create":
        return this.create(command);
      case "str_replace":
        return this.strReplace(command);
      case "insert":
        return this.insert(command);
      case "delete":
        return this.delete(command);
      case "rename":
        return this.rename(command);
      default: {
        // Exhaustiveness guard — unknown command shape.
        const unknown = command as { command?: string };
        return `Error: unsupported memory command "${unknown.command}".`;
      }
    }
  }

  /** Expose a `{ [command]: handler }` map for `betaMemoryTool(handlers)`. */
  toHandlers(): MemoryToolHandlers {
    return {
      view: (cmd) => this.view(cmd),
      create: (cmd) => this.create(cmd),
      str_replace: (cmd) => this.strReplace(cmd),
      insert: (cmd) => this.insert(cmd),
      delete: (cmd) => this.delete(cmd),
      rename: (cmd) => this.rename(cmd),
    };
  }

  // ── create / insert ──────────────────────────────────────────────────────
  // Both write new content; insert annotates the line for downstream context.

  private async create(cmd: MemoryCreateCommand): Promise<string> {
    const path = this.normalizePath(cmd.path);
    const { memory, persisted } = await this.remember(path, cmd.file_text);
    if (!persisted) {
      // Governance dropped the write (below adaptive threshold) — be explicit so
      // Claude doesn't believe a later `view` will find this content.
      return `Memory at ${path} was NOT stored (filtered by memory governance as low-salience; nothing was persisted).`;
    }
    return `Created memory file ${path} (id: ${memory.id}).`;
  }

  private async insert(cmd: MemoryInsertCommand): Promise<string> {
    const path = this.normalizePath(cmd.path);
    // Reka memories are atomic; model the insert as an appended fragment that
    // records its target line so a later `view` reconstructs ordering.
    const content = `[line ${cmd.insert_line}] ${cmd.insert_text}`;
    const { memory, persisted } = await this.remember(path, content);
    if (!persisted) {
      return `Text at line ${cmd.insert_line} of ${path} was NOT stored (filtered by memory governance as low-salience; nothing was persisted).`;
    }
    return `Inserted text at line ${cmd.insert_line} of ${path} (id: ${memory.id}).`;
  }

  // ── view ─────────────────────────────────────────────────────────────────
  // Directory path -> list memories whose path-tag starts with the prefix.
  // File path -> recall the exact path, falling back to semantic recall.

  private async view(cmd: MemoryViewCommand): Promise<string> {
    const path = this.normalizePath(cmd.path);
    const memories = await this.listByPathPrefix(path);

    if (memories.length === 0) {
      // Last resort: semantic recall so the model still gets relevant context.
      const recalled = await this.recall(path);
      if (recalled.length === 0) {
        return `No memories found at ${path}.`;
      }
      const lines = recalled.map((m) => `- (${m.id}) ${m.content}`);
      return `Related memories for ${path}:\n${lines.join("\n")}`;
    }

    // A single exact-path match reads like "viewing a file".
    const exact = memories.filter((m) =>
      (m.tags || []).includes(this.pathTag(path)),
    );
    if (exact.length > 0 && exact.length === memories.length) {
      const body = exact.map((m) => m.content).join("\n");
      return this.applyViewRange(body, cmd.view_range);
    }

    // Otherwise it reads like "listing a directory".
    const children = memories.map((m) => {
      const childPath = this.pathOf(m) || path;
      return `- ${childPath} (id: ${m.id})`;
    });
    return `Directory ${path}:\n${children.join("\n")}`;
  }

  /** Clamp output to the requested [start, end] (1-based, inclusive) line range. */
  private applyViewRange(body: string, range?: number[]): string {
    if (!range || range.length !== 2) return body;
    const [start, end] = range;
    const lines = body.split("\n");
    const from = Math.max(0, start - 1);
    const to = end === -1 ? lines.length : end;
    return lines.slice(from, to).join("\n");
  }

  // ── str_replace ──────────────────────────────────────────────────────────
  // Recall the file at the path, replace the substring, re-remember (new id),
  // then delete the superseded memory.

  private async strReplace(cmd: MemoryStrReplaceCommand): Promise<string> {
    const path = this.normalizePath(cmd.path);
    const existing = await this.listByPathPrefix(path);
    const target = existing.find(
      (m) =>
        (m.tags || []).includes(this.pathTag(path)) &&
        m.content.includes(cmd.old_str),
    );

    if (!target) {
      return `Error: could not find "${cmd.old_str}" in ${path}.`;
    }

    const updated = target.content.split(cmd.old_str).join(cmd.new_str);
    const { memory, persisted } = await this.remember(path, updated);
    if (!persisted) {
      // The replacement was filtered by governance — do NOT delete the original,
      // otherwise the content would be lost entirely.
      return `Update to ${path} was NOT stored (filtered by memory governance as low-salience); original (${target.id}) left unchanged.`;
    }
    await this.forget(target.id);
    return `Updated ${path} (new id: ${memory.id}, superseded: ${target.id}).`;
  }

  // ── delete ───────────────────────────────────────────────────────────────
  // Forget every memory at (or under) the path.

  private async delete(cmd: MemoryDeleteCommand): Promise<string> {
    const path = this.normalizePath(cmd.path);
    const memories = await this.listByPathPrefix(path);
    if (memories.length === 0) {
      return `No memories found at ${path} to delete.`;
    }
    let deleted = 0;
    for (const m of memories) {
      const ok = await this.forget(m.id);
      if (ok) deleted++;
    }
    return `Deleted ${deleted} memor${deleted === 1 ? "y" : "ies"} at ${path}.`;
  }

  // ── rename ───────────────────────────────────────────────────────────────
  // Recall everything at old_path, re-remember under new_path, delete originals.

  private async rename(cmd: MemoryRenameCommand): Promise<string> {
    const oldPath = this.normalizePath(cmd.old_path);
    const newPath = this.normalizePath(cmd.new_path);
    const memories = await this.listByPathPrefix(oldPath);
    if (memories.length === 0) {
      return `No memories found at ${oldPath} to rename.`;
    }
    let moved = 0;
    let skipped = 0;
    for (const m of memories) {
      // Preserve content; re-key the path tag/relatedTo to the new path.
      const childOld = this.pathOf(m) || oldPath;
      const childNew = childOld.replace(oldPath, newPath);
      const { persisted } = await this.remember(childNew, m.content);
      if (!persisted) {
        // Re-write was filtered by governance — keep the original so content
        // isn't lost during the move.
        skipped++;
        continue;
      }
      const ok = await this.forget(m.id);
      if (ok) moved++;
    }
    const base = `Renamed ${moved} memor${moved === 1 ? "y" : "ies"} from ${oldPath} to ${newPath}.`;
    return skipped > 0
      ? `${base} ${skipped} memor${skipped === 1 ? "y was" : "ies were"} NOT moved (filtered by memory governance; originals left in place).`
      : base;
  }

  // ── Reka API helpers ───────────────────────────────────────────────────────

  /**
   * remember: POST /api/memory with the path encoded as a tag + relatedTo.
   *
   * Attribution + governance routing (M2): `metadata.source = 'auto_memory_tool'`
   * routes the write through memoryGovernance.ingest into QUARANTINE
   * (`{project}_memory_pending`). We deliberately send NO confidence — ingest
   * only threshold-drops a write when confidence is defined, so a create always
   * persists (memory_20250818's create-succeeds expectation) and always lands
   * in quarantine. Quarantined writes are visible to this adapter's path-based
   * `view` (listByPathPrefix merges the quarantine tier — read-your-writes)
   * but NOT to `recall` until promoted: that IS the governance gate.
   *
   * The route returns `{ success, skipped, memory }` where `skipped: true` means
   * memory governance dropped the write (below the adaptive salience threshold) —
   * NOTHING was persisted. Unreachable for confidence-less writes, but we keep
   * surfacing the flag so callers don't report a write succeeded that a later
   * `view` can't find.
   */
  private async remember(
    path: string,
    content: string,
  ): Promise<{ memory: RekaMemory; persisted: boolean }> {
    const res = await this.api.post("/api/memory", {
      projectName: this.projectName,
      content,
      type: "note",
      tags: [this.pathTag(path)],
      relatedTo: path,
      metadata: { source: "auto_memory_tool" },
    });
    const skipped = res.data?.skipped === true;
    return { memory: res.data.memory as RekaMemory, persisted: !skipped };
  }

  /** recall: POST /api/memory/recall — semantic search used as a view fallback. */
  private async recall(query: string): Promise<RekaMemory[]> {
    const res = await this.api.post("/api/memory/recall", {
      projectName: this.projectName,
      query,
      type: "all",
      limit: 10,
    });
    // POST /api/memory/recall returns `{ results: [{ memory, score }] }` — each
    // element WRAPS the memory. Unwrap to the inner memory so downstream consumers
    // (view()'s fallback) read real id/content instead of "(undefined) undefined".
    // Guard for a flat `{ results: [memory] }` shape too, for resilience.
    const results = (res.data.results || []) as Array<
      { memory?: RekaMemory } & Partial<RekaMemory>
    >;
    return results
      .map((r) => (r && r.memory ? r.memory : (r as RekaMemory)))
      .filter((m): m is RekaMemory => Boolean(m && m.id));
  }

  /** forget: DELETE /api/memory/:id — returns true on success. */
  private async forget(id: string): Promise<boolean> {
    const res = await this.api.delete(
      `/api/memory/${id}?projectName=${encodeURIComponent(this.projectName)}`,
    );
    return Boolean(res.data?.success);
  }

  /**
   * List memories whose encoded path-tag matches `path` exactly OR sits under it
   * as a directory prefix.
   *
   * Merges TWO tiers (read-your-writes): the durable collection
   * (GET /api/memory/list) AND the governance quarantine
   * (GET /api/memory/quarantine?tag=…). Memory-tool writes carry
   * `source: 'auto_memory_tool'` and stay quarantined until promoted, so
   * without the quarantine tier a `view` right after `create` would come back
   * empty. The asymmetry is deliberate: path-based view/str_replace/delete/
   * rename see unpromoted writes, semantic `recall` does NOT — that is the
   * governance gate, not a bug.
   */
  private async listByPathPrefix(path: string): Promise<RekaMemory[]> {
    const tag = this.pathTag(path);
    const [durable, quarantined] = await Promise.all([
      this.listDurable(tag),
      this.listQuarantine(tag),
    ]);
    let memories = this.dedupeById([...durable, ...quarantined]);

    // Exact-tag filter found nothing -> treat as a directory: re-list unfiltered
    // and match any memory whose path tag begins with this path.
    if (memories.length === 0) {
      const [allDurable, allQuarantined] = await Promise.all([
        this.listDurable(),
        this.listQuarantine(),
      ]);
      const all = this.dedupeById([...allDurable, ...allQuarantined]);
      const dirPrefix = this.pathTag(path.endsWith("/") ? path : path + "/");
      memories = all.filter((m) =>
        (m.tags || []).some((t) => t === tag || t.startsWith(dirPrefix)),
      );
    }
    return memories;
  }

  /** GET /api/memory/list — durable tier, optionally filtered by exact tag. */
  private async listDurable(tag?: string): Promise<RekaMemory[]> {
    const params = new URLSearchParams({
      projectName: this.projectName,
      limit: "100",
      offset: "0",
    });
    if (tag) params.set("tag", tag);
    const res = await this.api.get(`/api/memory/list?${params}`);
    return (res.data.memories || []) as RekaMemory[];
  }

  /**
   * GET /api/memory/quarantine — unpromoted memory-tool writes, optionally
   * filtered by exact tag (`?tag=` is the M2 governance-route extension).
   * Best-effort: quarantine visibility is additive, so a failure here must
   * not break viewing durable memories.
   */
  private async listQuarantine(tag?: string): Promise<RekaMemory[]> {
    const params = new URLSearchParams({
      projectName: this.projectName,
      limit: "100",
    });
    if (tag) params.set("tag", tag);
    try {
      const res = await this.api.get(`/api/memory/quarantine?${params}`);
      return (res.data.memories || []) as RekaMemory[];
    } catch {
      return [];
    }
  }

  /** Drop duplicate/empty ids, preserving first occurrence (durable wins). */
  private dedupeById(memories: RekaMemory[]): RekaMemory[] {
    const seen = new Set<string>();
    return memories.filter((m) => {
      if (!m || !m.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  /** Extract the original memory-tool path from a memory's encoded tag. */
  private pathOf(m: RekaMemory): string | undefined {
    const tag = (m.tags || []).find((t) => t.startsWith(PATH_TAG_PREFIX));
    return tag ? tag.slice(PATH_TAG_PREFIX.length) : undefined;
  }
}
