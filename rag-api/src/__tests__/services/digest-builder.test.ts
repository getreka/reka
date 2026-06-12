import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  scrollCollection: vi.fn(),
  getCompactSummary: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: { scrollCollection: mocks.scrollCollection },
}));

vi.mock('../../services/project-profile', () => ({
  projectProfileService: { getCompactSummary: mocks.getCompactSummary },
}));

import { digestBuilder } from '../../services/digest-builder';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** Build the standard fixture set: pinned + ADR + durable + episodic + sessions. */
function fixturePoints() {
  const durable = [
    {
      id: 'pin-1',
      payload: {
        content: 'Always use npm 10 for lockfiles',
        type: 'procedure',
        pin: 'repo',
        tags: [],
        createdAt: iso(2 * DAY),
      },
    },
    {
      id: 'pin-2',
      payload: {
        content: 'User prefers concise answers',
        type: 'context',
        pin: 'all',
        tags: [],
        createdAt: iso(1 * DAY),
      },
    },
    {
      id: 'pin-superseded',
      payload: {
        content: 'Old pinned rule',
        type: 'note',
        pin: 'repo',
        tags: [],
        createdAt: iso(9 * DAY),
        supersededBy: 'pin-1',
      },
    },
    {
      id: 'adr-1',
      payload: {
        content:
          '# ADR: Use Redis for audit log\n\n## Status\nACCEPTED\n\n## Decision\nRedis lists with 90d TTL',
        type: 'decision',
        tags: ['adr'],
        createdAt: iso(3 * DAY),
        metadata: { adrTitle: 'Use Redis for audit log', adrStatus: 'accepted' },
      },
    },
    {
      id: 'adr-deprecated',
      payload: {
        content: '# ADR: Old choice\n\n## Decision\nDo not show this',
        type: 'decision',
        tags: ['adr'],
        createdAt: iso(4 * DAY),
        metadata: { adrTitle: 'Old choice', adrStatus: 'deprecated' },
      },
    },
    {
      id: 'dur-1',
      payload: {
        content: 'BGE-M3 batch endpoint is /embed/batch NOT /embed_batch',
        type: 'insight',
        tags: ['gotcha'],
        createdAt: iso(1 * DAY),
      },
    },
    {
      id: 'dur-old',
      payload: {
        content: 'Very old memory with low retention',
        type: 'note',
        tags: [],
        createdAt: iso(400 * DAY),
      },
    },
  ];

  const episodic = [
    {
      id: 'epi-1',
      payload: {
        content: 'Fixed the consolidation retry bug in session-actor',
        timestamp: iso(2 * DAY),
        stability: 7,
        accessCount: 1,
        sessionId: 'sess-prev',
      },
    },
    {
      id: 'epi-old',
      payload: {
        content: 'Too old episodic — outside the 7d window',
        timestamp: iso(10 * DAY),
        stability: 7,
        accessCount: 0,
        sessionId: 'sess-ancient',
      },
    },
  ];

  const sessions = [
    {
      id: 'sess-prev',
      payload: {
        sessionId: 'sess-prev',
        status: 'ended',
        startedAt: iso(1 * DAY),
        metadata: { summary: 'Shipped the M2 quarantine routing' },
      },
    },
    {
      id: 'sess-current',
      payload: {
        sessionId: 'sess-current',
        status: 'active',
        startedAt: iso(0),
      },
    },
  ];

  return { durable, episodic, sessions };
}

function mockScroll(fix: ReturnType<typeof fixturePoints>) {
  mocks.scrollCollection.mockImplementation(async (collection: string) => {
    if (collection.endsWith('_agent_memory')) return { points: fix.durable };
    if (collection.endsWith('_memory_episodic')) return { points: fix.episodic };
    if (collection.endsWith('_sessions')) return { points: fix.sessions };
    return { points: [] };
  });
}

describe('DigestBuilder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders all sections in order from fixtures, within line caps', async () => {
    mockScroll(fixturePoints());
    mocks.getCompactSummary.mockResolvedValue('Project: testproject | Stack: typescript(42)');

    const digest = await digestBuilder.build('testproject', 'sess-current');
    const md = digest.markdown;
    const lines = md.split('\n');

    // Header + section order
    expect(lines[0]).toBe('# Session Digest — testproject');
    const sectionOrder = lines.filter((l) => l.startsWith('## '));
    expect(sectionOrder).toEqual([
      '## Pinned',
      '## Accepted ADRs',
      '## Key Memories',
      '## Recent Activity (7d)',
      '## Project',
    ]);

    // Pinned: both pins, newest first, superseded excluded
    expect(md).toContain('Always use npm 10 for lockfiles');
    expect(md).toContain('User prefers concise answers');
    expect(md).not.toContain('Old pinned rule');
    expect(md.indexOf('User prefers concise answers')).toBeLessThan(
      md.indexOf('Always use npm 10 for lockfiles')
    );

    // ADRs: accepted only, decision text extracted
    expect(md).toContain('Use Redis for audit log');
    expect(md).toContain('Redis lists with 90d TTL');
    expect(md).not.toContain('Do not show this');

    // Key memories by retention: recent beats ancient
    expect(md).toContain('BGE-M3 batch endpoint');

    // Episodic: 7d window only
    expect(md).toContain('Fixed the consolidation retry bug');
    expect(md).not.toContain('Too old episodic');

    // Profile + continuity (current session excluded)
    expect(md).toContain('Project: testproject | Stack: typescript(42)');
    expect(md).toContain('Shipped the M2 quarantine routing');

    // Contract: <=200 lines
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(digest.lineCount).toBe(lines.length);

    // Audit-log feed: every rendered memory id captured, parallel snippets
    expect(digest.memoryIds).toContain('pin-1');
    expect(digest.memoryIds).toContain('adr-1');
    expect(digest.memoryIds).toContain('epi-1');
    expect(digest.memoryIds).not.toContain('pin-superseded');
    expect(digest.snippets.length).toBe(digest.memoryIds.length);
    expect(typeof digest.durationMs).toBe('number');
  });

  it('truncates long items to ~150 chars', async () => {
    const fix = fixturePoints();
    fix.durable.push({
      id: 'long-1',
      payload: {
        content: 'x'.repeat(500),
        type: 'note',
        pin: 'repo',
        tags: [],
        createdAt: iso(0.5 * DAY),
      },
    });
    mockScroll(fix);
    mocks.getCompactSummary.mockResolvedValue(null);

    const digest = await digestBuilder.build('testproject');
    const itemLine = digest.markdown.split('\n').find((l) => l.includes('xxx'))!;
    // "- [note] " prefix + 150-char body (with ellipsis)
    expect(itemLine.length).toBeLessThanOrEqual(165);
    expect(itemLine).toContain('…');
  });

  it('omits empty sections and tolerates missing collections (404)', async () => {
    // scrollCollection returns empty for everything (the 404 path)
    mocks.scrollCollection.mockResolvedValue({ points: [] });
    mocks.getCompactSummary.mockResolvedValue(null);

    const digest = await digestBuilder.build('emptyproject');

    expect(digest.markdown).toBe('# Session Digest — emptyproject');
    expect(digest.markdown).not.toContain('##');
    expect(digest.memoryIds).toEqual([]);
  });

  it('still builds remaining sections when a source throws', async () => {
    const fix = fixturePoints();
    mocks.scrollCollection.mockImplementation(async (collection: string) => {
      if (collection.endsWith('_agent_memory')) throw new Error('qdrant down');
      if (collection.endsWith('_memory_episodic')) return { points: fix.episodic };
      if (collection.endsWith('_sessions')) return { points: fix.sessions };
      return { points: [] };
    });
    mocks.getCompactSummary.mockRejectedValue(new Error('profile down'));

    const digest = await digestBuilder.build('testproject');

    expect(digest.markdown).toContain('## Recent Activity (7d)');
    expect(digest.markdown).toContain('Fixed the consolidation retry bug');
    expect(digest.markdown).not.toContain('## Pinned');
  });

  it('caps the digest at 200 lines total', async () => {
    const fix = fixturePoints();
    // Flood with pinned + durable items (caps per section keep this bounded,
    // but verify the global cap holds regardless)
    for (let i = 0; i < 300; i++) {
      fix.durable.push({
        id: `bulk-${i}`,
        payload: {
          content: `memory number ${i}`,
          type: 'note',
          pin: i % 2 === 0 ? 'repo' : undefined,
          tags: [],
          createdAt: iso(i * 1000),
        },
      } as any);
    }
    mockScroll(fix);
    mocks.getCompactSummary.mockResolvedValue('summary');

    const digest = await digestBuilder.build('testproject');
    expect(digest.markdown.split('\n').length).toBeLessThanOrEqual(200);
  });

  it('deduplicates memories across sections (pinned ADR appears once)', async () => {
    const fix = fixturePoints();
    // Make adr-1 ALSO pinned — it must render in Pinned and be skipped in ADRs
    (fix.durable.find((p) => p.id === 'adr-1')!.payload as any).pin = 'repo';
    mockScroll(fix);
    mocks.getCompactSummary.mockResolvedValue(null);

    const digest = await digestBuilder.build('testproject');
    const occurrences = digest.memoryIds.filter((id) => id === 'adr-1').length;
    expect(occurrences).toBe(1);
  });
});
