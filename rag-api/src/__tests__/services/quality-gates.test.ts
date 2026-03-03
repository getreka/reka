import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process
const mockExec = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  exec: mockExec,
}));

// Mock fs
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('fs', () => mockFs);

// Mock path (pass through)
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return actual;
});

// Mock graph store
const mockGraphStore = vi.hoisted(() => ({
  getBlastRadius: vi.fn(),
}));
vi.mock('../../services/graph-store', () => ({
  graphStore: mockGraphStore,
}));

// Mock metrics
vi.mock('../../utils/metrics', () => ({
  qualityGateResults: { inc: vi.fn() },
  qualityGateDuration: { observe: vi.fn() },
}));

import { qualityGates } from '../../services/quality-gates';

describe('QualityGateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runGates()', () => {
    it('runs all 3 gates by default', async () => {
      // Setup: tsconfig exists, vitest in deps
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        devDependencies: { vitest: '^1.0.0' },
      }));
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'success', '');
        return { kill: vi.fn() };
      });
      mockGraphStore.getBlastRadius.mockResolvedValue({
        affectedFiles: ['a.ts'],
        depth: 1,
        edgeCount: 1,
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: ['src/a.ts'],
      });

      expect(report.gates).toHaveLength(3);
      expect(report.passed).toBe(true);
    });

    it('skipGates skips specified gates', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'ok', '');
        return { kill: vi.fn() };
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['typecheck', 'blast_radius'],
      });

      const gateNames = report.gates.map(g => g.gate);
      expect(gateNames).not.toContain('typecheck');
      expect(gateNames).not.toContain('blast_radius');
      expect(gateNames).toContain('test');
    });
  });

  describe('typeCheckGate', () => {
    it('skips when no tsconfig.json found', async () => {
      mockFs.existsSync.mockReturnValue(false);
      // Don't need to mock test gate - skip it
      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['test', 'blast_radius'],
      });

      const tc = report.gates.find(g => g.gate === 'typecheck');
      expect(tc?.passed).toBe(true);
      expect(tc?.details).toContain('No tsconfig.json found');
    });

    it('passes when tsc succeeds', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, '', '');
        return { kill: vi.fn() };
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['test', 'blast_radius'],
      });

      const tc = report.gates.find(g => g.gate === 'typecheck');
      expect(tc?.passed).toBe(true);
    });

    it('fails when tsc reports errors', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('tsc failed'), 'src/a.ts(1,1): error TS2345', '');
        return { kill: vi.fn() };
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['test', 'blast_radius'],
      });

      const tc = report.gates.find(g => g.gate === 'typecheck');
      expect(tc?.passed).toBe(false);
    });

    it('filters errors by affectedFiles', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('tsc failed'), 'src/a.ts(1,1): error\nsrc/b.ts(2,1): error', '');
        return { kill: vi.fn() };
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: ['src/a.ts'],
        skipGates: ['test', 'blast_radius'],
      });

      const tc = report.gates.find(g => g.gate === 'typecheck');
      expect(tc?.details).toContain('src/a.ts');
    });
  });

  describe('testGate', () => {
    it('detects vitest and runs related tests', async () => {
      // First call is typecheck (skip), second is test
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        devDependencies: { vitest: '^1.0.0' },
      }));
      mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'Tests passed', '');
        return { kill: vi.fn() };
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['typecheck', 'blast_radius'],
      });

      const testGate = report.gates.find(g => g.gate === 'test');
      expect(testGate?.passed).toBe(true);
    });

    it('skips when no package.json found', async () => {
      mockFs.existsSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('package.json')) return false;
        return false;
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        skipGates: ['typecheck', 'blast_radius'],
      });

      const testGate = report.gates.find(g => g.gate === 'test');
      expect(testGate?.passed).toBe(true);
      expect(testGate?.details).toContain('No package.json');
    });
  });

  describe('blastRadiusGate', () => {
    it('passes when affected files <= 20', async () => {
      mockGraphStore.getBlastRadius.mockResolvedValue({
        affectedFiles: Array.from({ length: 5 }, (_, i) => `file${i}.ts`),
        depth: 2,
        edgeCount: 10,
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: ['src/a.ts'],
        skipGates: ['typecheck', 'test'],
      });

      const br = report.gates.find(g => g.gate === 'blast_radius');
      expect(br?.passed).toBe(true);
    });

    it('warns when affected files > 20', async () => {
      mockGraphStore.getBlastRadius.mockResolvedValue({
        affectedFiles: Array.from({ length: 25 }, (_, i) => `file${i}.ts`),
        depth: 3,
        edgeCount: 50,
      });

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: ['src/a.ts'],
        skipGates: ['typecheck', 'test'],
      });

      const br = report.gates.find(g => g.gate === 'blast_radius');
      expect(br?.passed).toBe(false);
    });

    it('handles graphStore error gracefully', async () => {
      mockGraphStore.getBlastRadius.mockRejectedValue(new Error('graph unavailable'));

      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: ['src/a.ts'],
        skipGates: ['typecheck', 'test'],
      });

      const br = report.gates.find(g => g.gate === 'blast_radius');
      expect(br?.passed).toBe(true);
      expect(br?.details).toContain('failed');
    });

    it('skips blast radius when no affected files', async () => {
      const report = await qualityGates.runGates({
        projectName: 'test',
        projectPath: '/tmp/project',
        affectedFiles: [],
        skipGates: ['typecheck', 'test'],
      });

      expect(report.gates.find(g => g.gate === 'blast_radius')).toBeUndefined();
    });
  });
});
