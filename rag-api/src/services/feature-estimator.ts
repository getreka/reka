/**
 * Feature Estimator - Complexity analysis, risk assessment, and subtask generation.
 *
 * Extracted from MCP pm.ts to keep business logic in the API layer.
 */

import { vectorStore } from './vector-store';
import { embeddingService } from './embedding';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface EstimateInput {
  projectName: string;
  feature: string;
  includeSubtasks?: boolean;
}

export interface EstimateResult {
  feature: string;
  complexity: string;
  complexityScore: number;
  riskLevel: string;
  riskScore: number;
  affectedFiles: string[];
  testFiles: string[];
  testRatio: number;
  avgCyclomaticComplexity: number;
  integrations: string[];
  complexFunctions: string[];
  riskFactors: string[];
  hasRequirements: boolean;
  hasExistingCode: boolean;
  hasTests: boolean;
  subtasks: string[] | null;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/** Regex-based cyclomatic complexity approximation for a code snippet. */
function analyzeCodeComplexity(content: string) {
  const ifCount = (content.match(/\bif\s*\(/g) || []).length;
  const elseCount = (content.match(/\belse\b/g) || []).length;
  const switchCount = (content.match(/\bswitch\s*\(/g) || []).length;
  const forCount = (content.match(/\bfor\s*\(/g) || []).length;
  const whileCount = (content.match(/\bwhile\s*\(/g) || []).length;
  const tryCount = (content.match(/\btry\s*\{/g) || []).length;
  const asyncCount = (content.match(/\basync\b/g) || []).length;
  const awaitCount = (content.match(/\bawait\b/g) || []).length;

  const cyclomaticComplexity =
    1 + ifCount + elseCount + switchCount + forCount + whileCount + tryCount;

  return { cyclomaticComplexity, asyncCount, awaitCount };
}

/** Detect integration points (imports, API calls, DB ops, external services). */
function detectIntegrations(content: string): {
  integrations: Set<string>;
  integrationPointCount: number;
} {
  const integrations = new Set<string>();

  const imports = content.match(/import\s+.*from\s+['"]([^'"]+)['"]/g) || [];
  const requires = content.match(/require\s*\(['"]([^'"]+)['"]\)/g) || [];
  const apiCalls = content.match(/(?:axios|fetch|http|api)\.[a-z]+\(/gi) || [];
  const dbOps = content.match(/(?:prisma|mongoose|sequelize|knex|db)\.[a-z]+/gi) || [];
  const externalServices = content.match(/(?:redis|kafka|rabbitmq|queue|cache)\.[a-z]+/gi) || [];

  [...imports, ...requires].forEach((imp) => {
    const match = imp.match(/['"]([^'"]+)['"]/);
    if (match && !match[1].startsWith('.')) {
      integrations.add(`Package: ${match[1]}`);
    }
  });

  if (apiCalls.length > 0) integrations.add('HTTP/API calls');
  if (dbOps.length > 0) integrations.add('Database operations');
  if (externalServices.length > 0) integrations.add('External services (cache/queue)');

  const integrationPointCount =
    imports.length + requires.length + apiCalls.length + dbOps.length;

  return { integrations, integrationPointCount };
}

/** Compute 0-100 complexity score from four factors. */
function computeComplexityScore(
  fileCount: number,
  avgComplexity: number,
  integrationCount: number,
  testRatio: number,
): { score: number; label: string } {
  let score = 0;

  // Factor 1: File count (0-30 points)
  if (fileCount > 15) score += 30;
  else if (fileCount > 8) score += 20;
  else if (fileCount > 3) score += 10;
  else score += 5;

  // Factor 2: Code complexity (0-30 points)
  if (avgComplexity > 15) score += 30;
  else if (avgComplexity > 8) score += 20;
  else if (avgComplexity > 4) score += 10;
  else score += 5;

  // Factor 3: Integration points (0-20 points)
  if (integrationCount > 6) score += 20;
  else if (integrationCount > 3) score += 15;
  else if (integrationCount > 1) score += 10;
  else score += 5;

  // Factor 4: Test coverage (0-20 points) — less tests = more risk
  if (testRatio < 0.2) score += 20;
  else if (testRatio < 0.5) score += 15;
  else if (testRatio < 0.8) score += 10;
  else score += 5;

  let label = 'Low';
  if (score >= 70) label = 'Very High';
  else if (score >= 50) label = 'High';
  else if (score >= 30) label = 'Medium';

  return { score, label };
}

/** Compute risk factors and score. */
function assessRisk(opts: {
  hasRequirements: boolean;
  hasExistingCode: boolean;
  hasTests: boolean;
  affectedFileCount: number;
  integrations: Set<string>;
  complexFunctionCount: number;
}): { riskFactors: string[]; riskScore: number; riskLevel: string } {
  const riskFactors: string[] = [];
  let riskScore = 0;

  if (!opts.hasRequirements) {
    riskFactors.push('No documented requirements - scope unclear');
    riskScore += 25;
  }
  if (opts.affectedFileCount > 10) {
    riskFactors.push(`Wide impact: ${opts.affectedFileCount} files affected`);
    riskScore += 20;
  }
  if (!opts.hasTests) {
    riskFactors.push('No existing tests found - regression risk');
    riskScore += 20;
  }
  if (opts.integrations.has('Database operations')) {
    riskFactors.push('Database changes - migration complexity');
    riskScore += 15;
  }
  if (opts.integrations.has('External services (cache/queue)')) {
    riskFactors.push('External service dependencies');
    riskScore += 15;
  }
  if (opts.complexFunctionCount > 3) {
    riskFactors.push(`${opts.complexFunctionCount} complex functions to modify`);
    riskScore += 15;
  }
  if (!opts.hasExistingCode) {
    riskFactors.push('New development - no patterns to follow');
    riskScore += 10;
  }

  let riskLevel = 'Low';
  if (riskScore >= 60) riskLevel = 'Critical';
  else if (riskScore >= 40) riskLevel = 'High';
  else if (riskScore >= 20) riskLevel = 'Medium';

  return { riskFactors, riskScore, riskLevel };
}

/** Generate suggested subtasks based on analysis. */
function generateSubtasks(opts: {
  hasRequirements: boolean;
  hasExistingCode: boolean;
  complexFunctionCount: number;
  integrations: Set<string>;
  affectedFileCount: number;
}): string[] {
  const tasks: string[] = [];

  tasks.push('Review and clarify requirements');
  if (!opts.hasRequirements) tasks.push('Document requirements');

  if (opts.hasExistingCode) {
    tasks.push('Analyze existing implementation and complexity');
    if (opts.complexFunctionCount > 0) {
      tasks.push('Refactor complex functions if needed');
    }
    tasks.push('Plan modifications');
  } else {
    tasks.push('Design solution architecture');
    tasks.push('Implement core functionality');
  }

  if (opts.integrations.has('Database operations')) {
    tasks.push('Create database migrations');
  }

  tasks.push(`Write/update tests (target: >${opts.affectedFileCount} test cases)`);

  if (opts.integrations.has('External services (cache/queue)')) {
    tasks.push('Integration testing with external services');
  }

  tasks.push('Code review & QA');
  tasks.push('Documentation update');

  return tasks;
}

// ----------------------------------------------------------------
// Main estimator
// ----------------------------------------------------------------

export async function estimateFeature(input: EstimateInput): Promise<EstimateResult> {
  const { projectName, feature, includeSubtasks = true } = input;
  const prefix = `${projectName}_`;

  // Search for related requirements, code, and tests in parallel
  const [reqEmbedding, codeEmbedding, testEmbedding] = await Promise.all([
    embeddingService.embed(feature),
    embeddingService.embed(feature),
    embeddingService.embed(`${feature} test spec`),
  ]);

  // Actually we can reuse the same embedding for requirements and code
  const [reqResults, codeResults, testResults] = await Promise.all([
    vectorStore.search(`${prefix}confluence`, reqEmbedding, 5).catch(() => []),
    vectorStore.search(`${prefix}codebase`, codeEmbedding, 15),
    vectorStore.search(`${prefix}codebase`, testEmbedding, 10, {
      must: [{ key: 'file', match: { text: 'test' } }],
    }).catch(() => []),
  ]);

  const hasRequirements = reqResults.length > 0;
  const hasExistingCode = codeResults.length > 0;
  const hasTests = testResults.length > 0;

  const affectedFiles = [...new Set(
    codeResults.map(r => r.payload.file as string).filter(Boolean),
  )];
  const testFiles = [...new Set(
    testResults.map(r => r.payload.file as string).filter(Boolean),
  )];

  // Analyze code complexity across all results
  let totalComplexityScore = 0;
  const allIntegrations = new Set<string>();
  const complexFunctions: string[] = [];

  for (const result of codeResults) {
    const content = String(result.payload.content || '');

    const { cyclomaticComplexity, asyncCount, awaitCount } = analyzeCodeComplexity(content);
    totalComplexityScore += cyclomaticComplexity;

    if (cyclomaticComplexity > 10) {
      const funcMatch = content.match(/(?:function|const|async)\s+(\w+)/);
      if (funcMatch) {
        complexFunctions.push(
          `${result.payload.file}: ${funcMatch[1]}() - complexity ~${cyclomaticComplexity}`,
        );
      }
    }

    const { integrations } = detectIntegrations(content);
    for (const i of integrations) allIntegrations.add(i);

    if (asyncCount > 3 || awaitCount > 3) {
      allIntegrations.add('Heavy async operations');
    }
  }

  const avgComplexity = codeResults.length > 0
    ? totalComplexityScore / codeResults.length
    : 0;

  const testRatio = affectedFiles.length > 0
    ? testFiles.length / affectedFiles.length
    : 0;

  const { score: complexityScore, label: complexity } = computeComplexityScore(
    affectedFiles.length, avgComplexity, allIntegrations.size, testRatio,
  );

  const { riskFactors, riskScore, riskLevel } = assessRisk({
    hasRequirements,
    hasExistingCode,
    hasTests,
    affectedFileCount: affectedFiles.length,
    integrations: allIntegrations,
    complexFunctionCount: complexFunctions.length,
  });

  const subtasks = includeSubtasks
    ? generateSubtasks({
        hasRequirements,
        hasExistingCode,
        complexFunctionCount: complexFunctions.length,
        integrations: allIntegrations,
        affectedFileCount: affectedFiles.length,
      })
    : null;

  return {
    feature,
    complexity,
    complexityScore,
    riskLevel,
    riskScore,
    affectedFiles,
    testFiles,
    testRatio,
    avgCyclomaticComplexity: parseFloat(avgComplexity.toFixed(1)),
    integrations: [...allIntegrations],
    complexFunctions,
    riskFactors,
    hasRequirements,
    hasExistingCode,
    hasTests,
    subtasks,
  };
}
