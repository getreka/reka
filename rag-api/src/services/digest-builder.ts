/**
 * Digest Builder — server-built session-start digest (M3 task 1).
 *
 * Assembles a <=200-line markdown digest with NO LLM call and NO query
 * embedding in the path — pure Qdrant scrolls + app-side ranking, so it is
 * fast (p95 < 2s) and safe to call from a SessionStart hook.
 *
 * Sections, in order (empty sections omitted):
 *   1. Pinned memories (pin='all'|'repo' — the pin scope's first consumer)
 *   2. Accepted ADRs (durable, tag 'adr')
 *   3. Top durable memories by computeRetention()
 *   4. Last-7d episodic, retention-weighted (404-tolerant — empty until the
 *      episodic pipeline produces writes)
 *   5. Project profile compact summary + last-session continuity
 *
 * Every section is independently fault-tolerant: a failing source yields an
 * empty section, never an error — a session start must never be blocked.
 */

import { vectorStore } from './vector-store';
import { computeRetention } from './memory-ltm';
import { projectProfileService } from './project-profile';
import { logger } from '../utils/logger';
import config from '../config';

// ── Limits ────────────────────────────────────────────────

/** Hard cap on total digest lines (contract: <=200). */
const MAX_TOTAL_LINES = 200;
/** Per-item content truncation (~150 chars). */
const ITEM_CHARS = 150;
/** Per-section item caps. */
const MAX_PINNED = 15;
const MAX_ADRS = 10;
const MAX_DURABLE = 15;
const MAX_EPISODIC = 10;
/** Over-fetch cap for the durable-collection scroll. */
const SCROLL_PAGE = 200;
const SCROLL_MAX_POINTS = 1000;

// ── Types ─────────────────────────────────────────────────

export interface SessionDigest {
  /** The digest markdown itself (the HTTP response body — no JSON wrapper). */
  markdown: string;
  lineCount: number;
  /** IDs of every memory included, for the retrieval audit log. */
  memoryIds: string[];
  /** Capped content snippets, parallel to memoryIds. */
  snippets: string[];
  durationMs: number;
}

interface SectionItems {
  lines: string[];
  ids: string[];
  snippets: string[];
}

interface ScrolledPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────

/** Squash whitespace and truncate to ITEM_CHARS. */
function snippet(text: string, max = ITEM_CHARS): string {
  const squashed = (text || '').replace(/\s+/g, ' ').trim();
  return squashed.length > max ? `${squashed.slice(0, max - 1)}…` : squashed;
}

function emptySection(): SectionItems {
  return { lines: [], ids: [], snippets: [] };
}

/** Extract the "## Decision" body from ADR markdown, falling back to full content. */
function adrDecision(content: string): string {
  const match = content.match(/##\s*Decision\s+([\s\S]*?)(?=\n##|$)/i);
  return match ? match[1] : content;
}

function createdAtOf(payload: Record<string, unknown>): string {
  return (payload.createdAt ?? payload.timestamp ?? '') as string;
}

// ── Service ───────────────────────────────────────────────

class DigestBuilderService {
  /**
   * Build the session-start digest for a project.
   * Never throws for per-section failures; returns whatever sections built.
   */
  async build(projectName: string, sessionId?: string): Promise<SessionDigest> {
    const startTime = Date.now();

    // One over-fetched scroll of the durable collection feeds sections 1-3.
    const durablePoints = await this.scrollAll(`${projectName}_agent_memory`);

    const seenIds = new Set<string>();
    const pinned = this.buildPinnedSection(durablePoints, seenIds);
    const adrs = this.buildAdrSection(durablePoints, seenIds);
    const topDurable = this.buildTopDurableSection(durablePoints, seenIds);
    const episodic = await this.buildEpisodicSection(projectName, seenIds);
    const profileLines = await this.buildProfileSection(projectName, sessionId);

    const lines: string[] = [`# Session Digest — ${projectName}`];
    const ids: string[] = [];
    const snippets: string[] = [];

    const appendSection = (title: string, section: SectionItems) => {
      if (section.lines.length === 0) return; // empty sections omitted
      lines.push('', `## ${title}`, ...section.lines);
      ids.push(...section.ids);
      snippets.push(...section.snippets);
    };

    appendSection('Pinned', pinned);
    appendSection('Accepted ADRs', adrs);
    appendSection('Key Memories', topDurable);
    appendSection('Recent Activity (7d)', episodic);
    if (profileLines.length > 0) {
      lines.push('', '## Project', ...profileLines);
    }

    const capped = lines.slice(0, MAX_TOTAL_LINES);
    const durationMs = Date.now() - startTime;

    logger.info('Session digest built', {
      projectName,
      sessionId,
      durationMs,
      lines: capped.length,
      memories: ids.length,
    });

    return {
      markdown: capped.join('\n'),
      lineCount: capped.length,
      memoryIds: ids,
      snippets,
      durationMs,
    };
  }

  // ── Sections ────────────────────────────────────────────

  /** Section 1: pinned memories (pin='all'|'repo'), newest first. */
  private buildPinnedSection(points: ScrolledPoint[], seenIds: Set<string>): SectionItems {
    try {
      const items = points
        .filter((p) => !p.payload.supersededBy)
        .filter((p) => p.payload.pin === 'all' || p.payload.pin === 'repo')
        .sort((a, b) => createdAtOf(b.payload).localeCompare(createdAtOf(a.payload)))
        .slice(0, MAX_PINNED);
      return this.renderMemoryItems(items, seenIds);
    } catch {
      return emptySection();
    }
  }

  /** Section 2: accepted ADRs (durable, tag 'adr'), newest first. */
  private buildAdrSection(points: ScrolledPoint[], seenIds: Set<string>): SectionItems {
    try {
      const section = emptySection();
      const adrs = points
        .filter((p) => !p.payload.supersededBy)
        .filter(
          (p) => Array.isArray(p.payload.tags) && (p.payload.tags as string[]).includes('adr')
        )
        .filter((p) => {
          const status = (p.payload.metadata as Record<string, unknown> | undefined)?.adrStatus;
          // Default ADR status is 'accepted'; absent means accepted.
          return status === undefined || String(status).toLowerCase() === 'accepted';
        })
        .sort((a, b) => createdAtOf(b.payload).localeCompare(createdAtOf(a.payload)))
        .slice(0, MAX_ADRS);

      for (const p of adrs) {
        const id = String(p.id);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const meta = p.payload.metadata as Record<string, unknown> | undefined;
        const title = (meta?.adrTitle as string) || (p.payload.relatedTo as string) || 'ADR';
        const decision = snippet(adrDecision((p.payload.content as string) || ''));
        section.lines.push(`- ${snippet(title, 80)}: ${decision}`);
        section.ids.push(id);
        section.snippets.push(decision);
      }
      return section;
    } catch {
      return emptySection();
    }
  }

  /** Section 3: top durable memories by computeRetention(). */
  private buildTopDurableSection(points: ScrolledPoint[], seenIds: Set<string>): SectionItems {
    try {
      const items = points
        .filter((p) => !p.payload.supersededBy)
        .filter((p) => !seenIds.has(String(p.id)))
        // ADRs have their own section; non-accepted ones (deprecated/superseded
        // status) are deliberately excluded noise — keep them out of Key Memories.
        .filter(
          (p) => !(Array.isArray(p.payload.tags) && (p.payload.tags as string[]).includes('adr'))
        )
        .map((p) => ({
          point: p,
          retention: computeRetention(
            createdAtOf(p.payload) || new Date(0).toISOString(),
            (p.payload.stability as number) ?? config.SEMANTIC_BASE_STABILITY_DAYS,
            (p.payload.accessCount as number) ?? 0
          ),
        }))
        .sort((a, b) => b.retention - a.retention)
        .slice(0, MAX_DURABLE)
        .map((r) => r.point);
      return this.renderMemoryItems(items, seenIds);
    } catch {
      return emptySection();
    }
  }

  /** Section 4: last-7d episodic, retention-weighted. 404-tolerant. */
  private async buildEpisodicSection(
    projectName: string,
    seenIds: Set<string>
  ): Promise<SectionItems> {
    try {
      const points = await this.scrollAll(`${projectName}_memory_episodic`);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const items = points
        .filter((p) => {
          const created = createdAtOf(p.payload);
          return created && new Date(created).getTime() >= cutoff;
        })
        .map((p) => ({
          point: p,
          retention: computeRetention(
            createdAtOf(p.payload),
            (p.payload.stability as number) ?? config.EPISODIC_BASE_STABILITY_DAYS,
            (p.payload.accessCount as number) ?? 0
          ),
        }))
        .sort((a, b) => b.retention - a.retention)
        .slice(0, MAX_EPISODIC)
        .map((r) => r.point);

      return this.renderMemoryItems(items, seenIds, 'episodic');
    } catch {
      return emptySection();
    }
  }

  /** Section 5: project profile compact summary + last-session continuity. */
  private async buildProfileSection(projectName: string, sessionId?: string): Promise<string[]> {
    const lines: string[] = [];

    try {
      const summary = await projectProfileService.getCompactSummary(projectName);
      if (summary) lines.push(`- ${snippet(summary, 300)}`);
    } catch {
      /* profile unavailable — omit */
    }

    try {
      const sessions = await vectorStore.scrollCollection(`${projectName}_sessions`, 100);
      const last = sessions.points
        .filter((p) => p.payload.status === 'ended' && p.payload.sessionId !== sessionId)
        .sort((a, b) =>
          String(b.payload.startedAt ?? '').localeCompare(String(a.payload.startedAt ?? ''))
        )[0];
      if (last) {
        const meta = last.payload.metadata as Record<string, unknown> | undefined;
        const summary = (meta?.summary as string) || '';
        const started = (last.payload.startedAt as string) || '';
        lines.push(
          `- Last session${started ? ` ${started.slice(0, 10)}` : ''}: ${
            summary ? snippet(summary) : 'no summary recorded'
          }`
        );
      }
    } catch {
      /* sessions unavailable — omit */
    }

    return lines;
  }

  // ── Internals ───────────────────────────────────────────

  /** Render memory points as one-line items, deduping across sections. */
  private renderMemoryItems(
    points: ScrolledPoint[],
    seenIds: Set<string>,
    typeOverride?: string
  ): SectionItems {
    const section = emptySection();
    for (const p of points) {
      const id = String(p.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const type = typeOverride || (p.payload.type as string) || 'note';
      const text = snippet((p.payload.content as string) || '');
      if (!text) continue;
      section.lines.push(`- [${type}] ${text}`);
      section.ids.push(id);
      section.snippets.push(text);
    }
    return section;
  }

  /** Over-fetch a collection via scrollCollection (no order_by — sort app-side). */
  private async scrollAll(collection: string): Promise<ScrolledPoint[]> {
    const points: ScrolledPoint[] = [];
    let offset: string | undefined = undefined;

    try {
      do {
        const page = await vectorStore.scrollCollection(collection, SCROLL_PAGE, offset, false);
        points.push(...(page.points as ScrolledPoint[]));
        offset = page.nextOffset as string | undefined;
      } while (offset && points.length < SCROLL_MAX_POINTS);
    } catch (error: any) {
      // scrollCollection already swallows 404; anything else degrades to empty.
      logger.debug('Digest scroll failed', { collection, error: error?.message });
    }

    return points;
  }
}

export const digestBuilder = new DigestBuilderService();
export default digestBuilder;
