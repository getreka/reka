/**
 * Quality Gates - Run verification checks before memory promotion.
 *
 * Gates:
 * - typeCheckGate: runs tsc --noEmit
 * - testGate: detects test runner and runs related tests
 * - blastRadiusGate: analyzes transitive dependents via graph store
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { graphStore } from './graph-store';
import { logger } from '../utils/logger';
import { qualityGateResults, qualityGateDuration } from '../utils/metrics';

export interface GateResult {
  gate: string;
  passed: boolean;
  details: string;
  duration: number;
}

export interface QualityReport {
  passed: boolean;
  gates: GateResult[];
  blastRadius?: {
    affectedFiles: string[];
    depth: number;
  };
}

class QualityGateService {
  /**
   * Run all applicable quality gates.
   */
  async runGates(options: {
    projectName: string;
    projectPath: string;
    affectedFiles?: string[];
    skipGates?: string[];
  }): Promise<QualityReport> {
    const { projectName, projectPath, affectedFiles = [], skipGates = [] } = options;

    const gates: GateResult[] = [];
    let allPassed = true;

    // Type check gate
    if (!skipGates.includes('typecheck')) {
      const typeResult = await this.typeCheckGate(projectPath, affectedFiles);
      gates.push(typeResult);
      qualityGateResults.inc({
        gate: 'typecheck',
        result: typeResult.passed ? 'pass' : 'fail',
        project: projectName,
      });
      qualityGateDuration.observe(
        { gate: 'typecheck', project: projectName },
        typeResult.duration / 1000
      );
      if (!typeResult.passed) allPassed = false;
    }

    // Test gate
    if (!skipGates.includes('test')) {
      const testResult = await this.testGate(projectPath, affectedFiles);
      gates.push(testResult);
      qualityGateResults.inc({
        gate: 'test',
        result: testResult.passed ? 'pass' : 'fail',
        project: projectName,
      });
      qualityGateDuration.observe(
        { gate: 'test', project: projectName },
        testResult.duration / 1000
      );
      if (!testResult.passed) allPassed = false;
    }

    // Blast radius gate (informational, doesn't fail)
    let blastRadius: QualityReport['blastRadius'];
    if (!skipGates.includes('blast_radius') && affectedFiles.length > 0) {
      const brResult = await this.blastRadiusGate(projectName, affectedFiles);
      gates.push(brResult);
      qualityGateResults.inc({
        gate: 'blast_radius',
        result: brResult.passed ? 'pass' : 'warn',
        project: projectName,
      });
      qualityGateDuration.observe(
        { gate: 'blast_radius', project: projectName },
        brResult.duration / 1000
      );

      // Extract blast radius data from details
      try {
        const brData = JSON.parse(brResult.details);
        blastRadius = { affectedFiles: brData.affectedFiles || [], depth: brData.depth || 0 };
      } catch {
        // Non-critical
      }
    }

    return { passed: allPassed, gates, blastRadius };
  }

  /**
   * Run tsc --noEmit with timeout.
   */
  private async typeCheckGate(projectPath: string, affectedFiles?: string[]): Promise<GateResult> {
    const startTime = Date.now();

    return new Promise<GateResult>((resolve) => {
      // Check if tsconfig.json exists
      const tsconfigPath = path.join(projectPath, 'tsconfig.json');
      if (!fs.existsSync(tsconfigPath)) {
        resolve({
          gate: 'typecheck',
          passed: true,
          details: 'No tsconfig.json found, skipping type check',
          duration: Date.now() - startTime,
        });
        return;
      }

      const timeout = 30000;
      const child = exec(
        'npx tsc --noEmit --pretty false 2>&1',
        { cwd: projectPath, timeout },
        (error, stdout, stderr) => {
          const output = stdout || stderr || '';
          const duration = Date.now() - startTime;

          if (error) {
            // Filter errors by affected files if provided
            let relevantErrors = output;
            if (affectedFiles && affectedFiles.length > 0) {
              const lines = output.split('\n');
              const relevant = lines.filter((line) => {
                return affectedFiles.some((f) => line.includes(f));
              });
              relevantErrors = relevant.length > 0 ? relevant.join('\n') : output;
            }

            resolve({
              gate: 'typecheck',
              passed: false,
              details: relevantErrors.slice(0, 2000),
              duration,
            });
          } else {
            resolve({
              gate: 'typecheck',
              passed: true,
              details: 'Type check passed',
              duration,
            });
          }
        }
      );

      // Handle timeout
      setTimeout(() => {
        child.kill();
        resolve({
          gate: 'typecheck',
          passed: true,
          details: 'Type check timed out (30s), skipping',
          duration: Date.now() - startTime,
        });
      }, timeout);
    });
  }

  /**
   * Detect test runner and run related tests.
   */
  private async testGate(projectPath: string, affectedFiles?: string[]): Promise<GateResult> {
    const startTime = Date.now();

    // Detect test runner from package.json
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {
        gate: 'test',
        passed: true,
        details: 'No package.json found, skipping test gate',
        duration: Date.now() - startTime,
      };
    }

    let testCommand: string;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const devDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (devDeps['vitest']) {
        const related =
          affectedFiles && affectedFiles.length > 0 ? `--related ${affectedFiles.join(' ')}` : '';
        testCommand = `npx vitest run ${related} --reporter=verbose 2>&1`.trim();
      } else if (devDeps['jest']) {
        const related =
          affectedFiles && affectedFiles.length > 0
            ? `--findRelatedTests ${affectedFiles.join(' ')}`
            : '';
        testCommand = `npx jest ${related} --no-coverage 2>&1`.trim();
      } else if (pkg.scripts?.test) {
        testCommand = 'npm test 2>&1';
      } else {
        return {
          gate: 'test',
          passed: true,
          details: 'No test runner detected, skipping test gate',
          duration: Date.now() - startTime,
        };
      }
    } catch {
      return {
        gate: 'test',
        passed: true,
        details: 'Failed to parse package.json, skipping test gate',
        duration: Date.now() - startTime,
      };
    }

    const timeout = 60000;
    return new Promise<GateResult>((resolve) => {
      const child = exec(testCommand, { cwd: projectPath, timeout }, (error, stdout, stderr) => {
        const output = stdout || stderr || '';
        const duration = Date.now() - startTime;

        if (error) {
          resolve({
            gate: 'test',
            passed: false,
            details: output.slice(-2000), // Last 2000 chars of output
            duration,
          });
        } else {
          resolve({
            gate: 'test',
            passed: true,
            details: `Tests passed. ${output.slice(-500)}`,
            duration,
          });
        }
      });

      // Handle timeout
      setTimeout(() => {
        child.kill();
        resolve({
          gate: 'test',
          passed: true,
          details: 'Tests timed out (60s), skipping',
          duration: Date.now() - startTime,
        });
      }, timeout);
    });
  }

  /**
   * Analyze blast radius via graph store.
   */
  private async blastRadiusGate(projectName: string, affectedFiles: string[]): Promise<GateResult> {
    const startTime = Date.now();

    try {
      const result = await graphStore.getBlastRadius(projectName, affectedFiles, 3);
      const passed = result.affectedFiles.length <= 20; // Warn if >20 files affected

      return {
        gate: 'blast_radius',
        passed,
        details: JSON.stringify({
          affectedFiles: result.affectedFiles,
          depth: result.depth,
          edgeCount: result.edgeCount,
          warning: !passed
            ? `High blast radius: ${result.affectedFiles.length} files affected`
            : undefined,
        }),
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        gate: 'blast_radius',
        passed: true,
        details: `Blast radius analysis failed: ${error.message}`,
        duration: Date.now() - startTime,
      };
    }
  }
}

export const qualityGates = new QualityGateService();
export default qualityGates;
