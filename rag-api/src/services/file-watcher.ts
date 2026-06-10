/**
 * File Watcher Service
 *
 * Watches a project's working tree and incrementally re-indexes files as they
 * change — closing the "stale index" gap vs. tools like Cursor / claude-context.
 *
 * Bursts are debounced (~500ms) and batched, then handed to the indexer's
 * incremental re-index path. Multiple projects can be watched concurrently via
 * an internal registry. All I/O is guarded so a watcher error never crashes the
 * host process.
 */

import * as fs from 'fs';
import * as path from 'path';
import { watch, type FSWatcher } from 'chokidar';
import { logger } from '../utils/logger';
import { reindexChangedFiles } from './indexer';

// Directories never worth watching/re-indexing. Matched against any path segment.
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.vite',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  'vendor',
  'target',
]);

const DEFAULT_DEBOUNCE_MS = 500;
/** Cap on automatic retries of a failed reindex before we give up on the batch. */
const MAX_REINDEX_RETRIES = 5;

export interface WatchHandle {
  projectName: string;
  projectPath: string;
  watcher: FSWatcher;
  /** Pending change buffers, flushed on debounce. */
  changed: Set<string>;
  removed: Set<string>;
  debounceTimer?: NodeJS.Timeout;
  /** Serialize reindex runs so a slow batch can't overlap the next flush. */
  flushing: boolean;
  /** Consecutive reindex failures for the currently-buffered batch. */
  retryCount: number;
  /** Set once stop() begins closing the watcher; blocks start() from racing. */
  closing: boolean;
}

export interface FileWatcherOptions {
  /** Override the debounce window (ms). Defaults to 500ms. */
  debounceMs?: number;
  /**
   * Injectable reindex function — primarily for tests. Defaults to the real
   * indexer's incremental reindex.
   */
  reindex?: typeof reindexChangedFiles;
}

/**
 * Parse a project's .gitignore into a set of simple path fragments. Best-effort
 * only: we strip comments/negations/globs and keep plain directory or file
 * names, which we then match as path substrings. This intentionally avoids a
 * full gitignore engine — the goal is to cut obvious noise, not be exhaustive.
 */
function loadGitignoreFragments(projectPath: string): string[] {
  try {
    const file = path.join(projectPath, '.gitignore');
    const raw = fs.readFileSync(file, 'utf-8');
    const fragments: string[] = [];
    for (const lineRaw of raw.split('\n')) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      // Drop glob characters — we only keep a literal fragment to substring-match.
      const cleaned = line
        .replace(/[*?[\]{}]/g, '')
        .replace(/^\/+|\/+$/g, '')
        .trim();
      if (cleaned && !cleaned.includes('!')) {
        fragments.push(cleaned);
      }
    }
    return fragments;
  } catch {
    // No .gitignore (or unreadable) — fine, fall back to the static ignore set.
    return [];
  }
}

export class FileWatcher {
  private watchers: Map<string, WatchHandle> = new Map();
  private debounceMs: number;
  private reindexFn: typeof reindexChangedFiles;

  constructor(options: FileWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.reindexFn = options.reindex ?? reindexChangedFiles;
  }

  /**
   * Build the chokidar `ignored` predicate: rejects watched-dir noise and
   * best-effort .gitignore fragments. chokidar v5 passes an absolute path.
   */
  private buildIgnored(projectPath: string): (testPath: string) => boolean {
    const gitignore = loadGitignoreFragments(projectPath);
    return (testPath: string): boolean => {
      const normalized = testPath.replace(/\\/g, '/');
      const segments = normalized.split('/');
      for (const seg of segments) {
        if (IGNORED_DIRS.has(seg)) return true;
      }
      // Relative-path substring match for .gitignore fragments.
      const rel = path.relative(projectPath, testPath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        for (const frag of gitignore) {
          if (rel === frag || rel.startsWith(frag + '/') || rel.includes('/' + frag)) {
            return true;
          }
        }
      }
      return false;
    };
  }

  /** True if this project is currently being watched. */
  isWatching(projectName: string): boolean {
    return this.watchers.has(projectName);
  }

  /** Names of all currently watched projects. */
  watchedProjects(): string[] {
    return [...this.watchers.keys()];
  }

  /**
   * Start watching a project. Idempotent — calling start() again for an already
   * watched project is a no-op. Never throws: any setup failure is logged.
   */
  start(projectName: string, projectPath: string): void {
    try {
      const existing = this.watchers.get(projectName);
      if (existing) {
        // Already watched — or a stop() is mid-close. Either way, do NOT spawn a
        // second chokidar watcher on the same path (duplicate events / fd leak).
        if (existing.closing) {
          logger.debug(`File watcher for ${projectName} is closing; skipping start`);
        } else {
          logger.debug(`File watcher already active for ${projectName}`);
        }
        return;
      }
      if (!projectPath || !fs.existsSync(projectPath)) {
        logger.warn(`File watcher not started — path does not exist`, {
          projectName,
          projectPath,
        });
        return;
      }

      const watcher = watch(projectPath, {
        ignored: this.buildIgnored(projectPath),
        ignoreInitial: true, // don't re-index everything on boot
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        ignorePermissionErrors: true,
      });

      const handle: WatchHandle = {
        projectName,
        projectPath,
        watcher,
        changed: new Set(),
        removed: new Set(),
        flushing: false,
        retryCount: 0,
        closing: false,
      };

      watcher.on('add', (p: string) => this.enqueue(handle, p, 'changed'));
      watcher.on('change', (p: string) => this.enqueue(handle, p, 'changed'));
      watcher.on('unlink', (p: string) => this.enqueue(handle, p, 'removed'));
      watcher.on('error', (err: unknown) => {
        logger.warn(`File watcher error for ${projectName}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.watchers.set(projectName, handle);
      logger.info(`File watcher started for ${projectName}`, { projectPath });
    } catch (err: any) {
      logger.warn(`Failed to start file watcher for ${projectName}`, {
        error: err?.message || String(err),
      });
    }
  }

  /**
   * Buffer a path and (re)arm the debounce timer. A path appearing as both
   * changed and removed within a window resolves to its latest event.
   */
  private enqueue(handle: WatchHandle, filePath: string, kind: 'changed' | 'removed'): void {
    try {
      if (kind === 'removed') {
        handle.changed.delete(filePath);
        handle.removed.add(filePath);
      } else {
        handle.removed.delete(filePath);
        handle.changed.add(filePath);
      }

      if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
      handle.debounceTimer = setTimeout(() => {
        void this.flush(handle);
      }, this.debounceMs);
    } catch (err: any) {
      logger.debug(`Failed to enqueue watch event`, { error: err?.message });
    }
  }

  /**
   * Flush buffered changes for a project to the incremental reindexer. Guards
   * against overlapping runs and never throws.
   */
  private async flush(handle: WatchHandle): Promise<void> {
    if (handle.flushing) {
      // A run is in progress — re-arm so the new events flush right after.
      handle.debounceTimer = setTimeout(() => {
        void this.flush(handle);
      }, this.debounceMs);
      return;
    }

    const changed = [...handle.changed];
    const removed = [...handle.removed];
    handle.changed.clear();
    handle.removed.clear();

    if (changed.length === 0 && removed.length === 0) return;

    handle.flushing = true;
    logger.info(`File watcher flush for ${handle.projectName}`, {
      added_changed: changed.length,
      removed: removed.length,
    });

    try {
      const result = await this.reindexFn({
        projectName: handle.projectName,
        projectPath: handle.projectPath,
        changed,
        removed,
      });
      // Batch landed — clear the failure counter for the next batch.
      handle.retryCount = 0;
      logger.info(`File watcher reindex done for ${handle.projectName}`, {
        reindexed: result.reindexedFiles,
        removed: result.removedFiles,
        skipped: result.skippedUnchanged,
        errors: result.errors,
      });
    } catch (err: any) {
      // Re-queue the batch so a transient failure doesn't drop changes.
      for (const c of changed) handle.changed.add(c);
      for (const r of removed) handle.removed.add(r);
      handle.retryCount += 1;
      const message = err?.message || String(err);
      if (handle.closing) {
        // Project is being torn down — don't re-arm a timer on a dead handle.
        logger.debug(`File watcher reindex failed during shutdown for ${handle.projectName}`, {
          error: message,
        });
      } else if (handle.retryCount > MAX_REINDEX_RETRIES) {
        // Give up auto-retrying; the batch stays buffered and will flush on the
        // next file event, but we stop spinning a timer so the failure is loud.
        logger.warn(
          `File watcher reindex failed for ${handle.projectName} — giving up after ${MAX_REINDEX_RETRIES} retries`,
          {
            error: message,
            pending_changed: handle.changed.size,
            pending_removed: handle.removed.size,
          }
        );
      } else {
        // Re-arm the timer so the requeued batch is retried automatically even
        // if no further file events arrive. Exponential backoff, capped.
        const backoff = Math.min(this.debounceMs * 2 ** (handle.retryCount - 1), 30_000);
        logger.warn(
          `File watcher reindex failed for ${handle.projectName} — retry ${handle.retryCount}/${MAX_REINDEX_RETRIES} in ${backoff}ms`,
          { error: message }
        );
        if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
        handle.debounceTimer = setTimeout(() => {
          void this.flush(handle);
        }, backoff);
      }
    } finally {
      handle.flushing = false;
    }
  }

  /**
   * Stop watching a project and release its watcher. Idempotent and safe.
   */
  async stop(projectName: string): Promise<void> {
    const handle = this.watchers.get(projectName);
    if (!handle) return;
    // Already being closed by a concurrent stop() — don't double-close.
    if (handle.closing) return;
    // Mark closing but KEEP the handle in the registry until close() resolves, so
    // a start() racing this stop() still trips the has()-guard and can't spawn a
    // second watcher on the same path. Removing before the await opened that race.
    handle.closing = true;
    if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
    handle.debounceTimer = undefined;
    try {
      await handle.watcher.close();
      logger.info(`File watcher stopped for ${projectName}`);
    } catch (err: any) {
      logger.debug(`Failed to close watcher for ${projectName}`, { error: err?.message });
    } finally {
      // Only drop our handle — if a later start() already replaced it, leave it.
      if (this.watchers.get(projectName) === handle) {
        this.watchers.delete(projectName);
      }
    }
  }

  /** Stop all watchers (used on process shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((name) => this.stop(name)));
  }
}

// Singleton, mirroring the other service-layer exports.
export const fileWatcher = new FileWatcher();
