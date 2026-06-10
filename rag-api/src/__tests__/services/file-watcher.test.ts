import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Fake chokidar watcher we can drive from tests. watch() returns this instance.
class FakeWatcher extends EventEmitter {
  closed = false;
  close = vi.fn(async () => {
    this.closed = true;
  });
}

const watchMock = vi.hoisted(() => vi.fn());

vi.mock('chokidar', () => ({
  watch: watchMock,
  default: { watch: watchMock },
}));

// Keep the real indexer module out of the graph — we inject reindex directly.
vi.mock('../../services/indexer', () => ({
  reindexChangedFiles: vi.fn(),
}));

// existsSync must return true so start() proceeds; readFileSync(.gitignore) throws.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => {
      throw new Error('no gitignore');
    }),
  };
});

import { FileWatcher } from '../../services/file-watcher';

describe('FileWatcher — debounce / batch', () => {
  let currentWatcher: FakeWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    currentWatcher = new FakeWatcher();
    watchMock.mockReset();
    watchMock.mockImplementation(() => currentWatcher);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('batches a burst of events into a single reindex call after the debounce', async () => {
    const reindex = vi.fn().mockResolvedValue({
      reindexedFiles: 2,
      removedFiles: 1,
      skippedUnchanged: 0,
      totalChunks: 5,
      errors: 0,
      duration: 1,
    });
    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    expect(fw.isWatching('proj')).toBe(true);

    // Burst within the debounce window.
    currentWatcher.emit('add', '/abs/proj/a.ts');
    currentWatcher.emit('change', '/abs/proj/b.ts');
    currentWatcher.emit('unlink', '/abs/proj/c.ts');

    // Nothing fires before the window elapses.
    expect(reindex).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(reindex).toHaveBeenCalledTimes(1);
    const arg = reindex.mock.calls[0][0];
    expect(arg.projectName).toBe('proj');
    expect(arg.projectPath).toBe('/abs/proj');
    expect(arg.changed.sort()).toEqual(['/abs/proj/a.ts', '/abs/proj/b.ts']);
    expect(arg.removed).toEqual(['/abs/proj/c.ts']);
  });

  it('debounce is retriggered by later events (only one flush at the end)', async () => {
    const reindex = vi.fn().mockResolvedValue({
      reindexedFiles: 1,
      removedFiles: 0,
      skippedUnchanged: 0,
      totalChunks: 1,
      errors: 0,
      duration: 1,
    });
    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    currentWatcher.emit('change', '/abs/proj/a.ts');
    await vi.advanceTimersByTimeAsync(300); // not yet
    expect(reindex).not.toHaveBeenCalled();

    currentWatcher.emit('change', '/abs/proj/b.ts'); // re-arms timer
    await vi.advanceTimersByTimeAsync(300); // 300ms since last event — still pending
    expect(reindex).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200); // now 500ms since last event
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(reindex.mock.calls[0][0].changed.sort()).toEqual(['/abs/proj/a.ts', '/abs/proj/b.ts']);
  });

  it('a later unlink supersedes an earlier change for the same path', async () => {
    const reindex = vi.fn().mockResolvedValue({
      reindexedFiles: 0,
      removedFiles: 1,
      skippedUnchanged: 0,
      totalChunks: 0,
      errors: 0,
      duration: 1,
    });
    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    currentWatcher.emit('change', '/abs/proj/x.ts');
    currentWatcher.emit('unlink', '/abs/proj/x.ts');
    await vi.advanceTimersByTimeAsync(500);

    const arg = reindex.mock.calls[0][0];
    expect(arg.changed).toEqual([]);
    expect(arg.removed).toEqual(['/abs/proj/x.ts']);
  });

  it('does not call reindex when there are no buffered events', async () => {
    const reindex = vi.fn();
    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');
    await vi.advanceTimersByTimeAsync(1000);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('does not overlap reindex runs; a flush mid-run re-arms', async () => {
    let resolveFirst!: () => void;
    const reindex = vi
      .fn()
      // First call hangs until we resolve it.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () =>
              resolve({
                reindexedFiles: 1,
                removedFiles: 0,
                skippedUnchanged: 0,
                totalChunks: 1,
                errors: 0,
                duration: 1,
              });
          })
      )
      .mockResolvedValue({
        reindexedFiles: 1,
        removedFiles: 0,
        skippedUnchanged: 0,
        totalChunks: 1,
        errors: 0,
        duration: 1,
      });

    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    currentWatcher.emit('change', '/abs/proj/a.ts');
    await vi.advanceTimersByTimeAsync(500); // first flush starts (and hangs)
    expect(reindex).toHaveBeenCalledTimes(1);

    // New event arrives while the first run is still in flight.
    currentWatcher.emit('change', '/abs/proj/b.ts');
    await vi.advanceTimersByTimeAsync(500);
    // Still only one call — the second flush should be deferred, not overlapping.
    expect(reindex).toHaveBeenCalledTimes(1);

    // Let the first run finish, then the deferred flush should run.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(500);
    expect(reindex).toHaveBeenCalledTimes(2);
    expect(reindex.mock.calls[1][0].changed).toEqual(['/abs/proj/b.ts']);
  });

  it('stop() closes the watcher and clears the registry', async () => {
    const fw = new FileWatcher({ debounceMs: 500, reindex: vi.fn() });
    fw.start('proj', '/abs/proj');
    expect(fw.watchedProjects()).toEqual(['proj']);

    await fw.stop('proj');
    expect(currentWatcher.close).toHaveBeenCalled();
    expect(fw.isWatching('proj')).toBe(false);
  });

  it('start() is idempotent for an already-watched project', () => {
    const fw = new FileWatcher({ debounceMs: 500, reindex: vi.fn() });
    fw.start('proj', '/abs/proj');
    fw.start('proj', '/abs/proj');
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms the flush timer after a reindex failure so the batch is retried', async () => {
    // First reindex throws, second succeeds. Without re-arming the timer the
    // requeued batch would sit forever until an unrelated event fired.
    const reindex = vi.fn().mockRejectedValueOnce(new Error('qdrant down')).mockResolvedValue({
      reindexedFiles: 1,
      removedFiles: 0,
      skippedUnchanged: 0,
      totalChunks: 1,
      errors: 0,
      duration: 1,
    });

    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    currentWatcher.emit('change', '/abs/proj/a.ts');
    await vi.advanceTimersByTimeAsync(500); // first flush — throws, requeues, re-arms
    expect(reindex).toHaveBeenCalledTimes(1);

    // No further file events. The re-armed timer (backoff = debounceMs * 2^0 = 500ms)
    // must fire on its own and retry the SAME batch.
    await vi.advanceTimersByTimeAsync(500);
    expect(reindex).toHaveBeenCalledTimes(2);
    expect(reindex.mock.calls[1][0].changed).toEqual(['/abs/proj/a.ts']);
  });

  it('stops auto-retrying after the retry cap is exhausted', async () => {
    const reindex = vi.fn().mockRejectedValue(new Error('persistent failure'));
    const fw = new FileWatcher({ debounceMs: 500, reindex });
    fw.start('proj', '/abs/proj');

    currentWatcher.emit('change', '/abs/proj/a.ts');
    // Initial flush + capped retries; advance generously past all backoff windows.
    await vi.advanceTimersByTimeAsync(500); // attempt 1
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000); // drain any re-armed backoff timers
    }

    // Initial attempt + MAX_REINDEX_RETRIES (5) automatic retries = 6 total, then stop.
    expect(reindex).toHaveBeenCalledTimes(6);

    // No timer is left armed — further time advances trigger no more calls.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reindex).toHaveBeenCalledTimes(6);
  });

  it('start() racing an in-flight stop() does not create a second watcher', async () => {
    // close() resolves only when we let it, simulating a slow teardown that a
    // racing start() could slip past.
    let releaseClose!: () => void;
    const firstWatcher = currentWatcher;
    firstWatcher.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );

    const fw = new FileWatcher({ debounceMs: 500, reindex: vi.fn() });
    fw.start('proj', '/abs/proj');
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Begin stopping; close() is now pending (not yet resolved).
    const stopPromise = fw.stop('proj');

    // A start() racing the in-flight stop must NOT spawn a second chokidar watcher.
    fw.start('proj', '/abs/proj');
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Let close() finish; the handle is then removed from the registry.
    releaseClose();
    await stopPromise;
    expect(firstWatcher.close).toHaveBeenCalledTimes(1);
    expect(fw.isWatching('proj')).toBe(false);
  });

  it('a second concurrent stop() does not double-close the watcher', async () => {
    let releaseClose!: () => void;
    const firstWatcher = currentWatcher;
    firstWatcher.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );

    const fw = new FileWatcher({ debounceMs: 500, reindex: vi.fn() });
    fw.start('proj', '/abs/proj');

    const stop1 = fw.stop('proj');
    const stop2 = fw.stop('proj'); // races the first; must be a no-op close

    releaseClose();
    await Promise.all([stop1, stop2]);
    expect(firstWatcher.close).toHaveBeenCalledTimes(1);
    expect(fw.isWatching('proj')).toBe(false);
  });
});
