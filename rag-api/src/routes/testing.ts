/**
 * Testing Routes - AI-powered test generation
 */

import { Router, Request, Response } from 'express';
import { vectorStore } from '../services/vector-store';
import { embeddingService } from '../services/embedding';
import { llm } from '../services/llm';
import { asyncHandler } from '../middleware/async-handler';
import { validate, validateProjectName, generateTestsSchema } from '../utils/validation';

const router = Router();

/**
 * Generate tests for code
 * POST /api/generate-tests
 */
router.post(
  '/generate-tests',
  validateProjectName,
  validate(generateTestsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, code, filePath, framework, testType, coverage } = req.body;

    const collectionName = `${projectName}_codebase`;

    // 1. Find existing test patterns in codebase
    let existingTests: Array<{ payload: Record<string, unknown>; score: number; id: string }> = [];
    const testQuery = `test spec ${framework} ${filePath || ''}`;
    const testEmbedding = await embeddingService.embed(testQuery);
    existingTests = await vectorStore.search(collectionName, testEmbedding, 5, {
      must: [{ key: 'file', match: { text: '.test.' } }],
    });

    // 2. Analyze code structure
    const codeAnalysis = analyzeCodeStructure(code);

    // 3. Build test generation prompt
    const existingTestContext =
      existingTests.length > 0
        ? `\n\nExisting test patterns in this project:\n${existingTests.map((t) => `\`\`\`\n${(t.payload.content as string).slice(0, 500)}\n\`\`\``).join('\n')}`
        : '';

    const prompt = buildTestPrompt(
      code,
      filePath,
      framework,
      testType,
      coverage,
      codeAnalysis,
      existingTestContext
    );

    // 4. Generate tests
    const result = await llm.complete(prompt, {
      systemPrompt: getTestSystemPrompt(framework),
      maxTokens: 4000,
      temperature: 0.3,
    });

    const tests = extractTestCode(result.text);

    res.json({
      tests,
      framework,
      testType,
      analysis: codeAnalysis,
      existingPatternsFound: existingTests.length,
    });
  })
);

/**
 * Generate test cases without full implementation
 * POST /api/generate-test-cases
 */
router.post(
  '/generate-test-cases',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, requirements } = req.body;

    if (!code && !requirements) {
      return res.status(400).json({ error: 'code or requirements is required' });
    }

    const prompt = code
      ? `Generate test cases for this code:\n\n\`\`\`\n${code}\n\`\`\``
      : `Generate test cases for these requirements:\n\n${requirements}`;

    const result = await llm.complete(prompt, {
      systemPrompt: TEST_CASES_SYSTEM_PROMPT,
      maxTokens: 2000,
      temperature: 0.3,
      format: 'json',
    });

    let testCases;
    try {
      testCases = JSON.parse(result.text);
    } catch {
      testCases = {
        testCases: [],
        summary: result.text,
      };
    }

    res.json(testCases);
  })
);

/**
 * Analyze existing tests
 * POST /api/analyze-tests
 */
router.post(
  '/analyze-tests',
  asyncHandler(async (req: Request, res: Response) => {
    const { testCode, sourceCode } = req.body;

    if (!testCode) {
      return res.status(400).json({ error: 'testCode is required' });
    }

    const sourceContext = sourceCode
      ? `\n\nSource code being tested:\n\`\`\`\n${sourceCode}\n\`\`\``
      : '';

    const result = await llm.complete(
      `Analyze these tests for coverage and quality:\n\n\`\`\`\n${testCode}\n\`\`\`${sourceContext}`,
      {
        systemPrompt: TEST_ANALYSIS_SYSTEM_PROMPT,
        maxTokens: 2000,
        temperature: 0.3,
        format: 'json',
      }
    );

    let analysis;
    try {
      analysis = JSON.parse(result.text);
    } catch {
      analysis = {
        quality: 'unknown',
        coverage: {},
        suggestions: [],
        summary: result.text,
      };
    }

    res.json({ analysis });
  })
);

// ============================================
// System Prompts
// ============================================

function getTestSystemPrompt(framework: string): string {
  const frameworkSpecifics: Record<string, string> = {
    jest: 'Use Jest syntax with describe/it/expect. Include beforeEach/afterEach for setup/teardown.',
    vitest: 'Use Vitest syntax (similar to Jest). Use vi for mocking.',
    pytest: 'Use pytest with fixtures. Use pytest.mark for categorization.',
    mocha: 'Use Mocha with Chai assertions. Use describe/it blocks.',
  };

  return `You are a test engineering expert. Generate comprehensive tests.

Framework: ${framework}
${frameworkSpecifics[framework] || ''}

Requirements:
- Write clear, maintainable tests
- Cover edge cases and error scenarios
- Use descriptive test names
- Include setup and teardown when needed
- Mock external dependencies
- Follow AAA pattern (Arrange, Act, Assert)

Output the complete test file that can be run directly.`;
}

const TEST_CASES_SYSTEM_PROMPT = `You are a QA expert. Generate comprehensive test cases. Return JSON:

{
  "testCases": [
    {
      "id": "TC001",
      "name": "Test case name",
      "description": "What it tests",
      "type": "unit|integration|e2e",
      "priority": "high|medium|low",
      "preconditions": ["Setup requirements"],
      "steps": ["Step 1", "Step 2"],
      "expectedResult": "What should happen",
      "edgeCases": ["Related edge cases to consider"]
    }
  ],
  "coverage": {
    "happyPath": ["Scenarios covered"],
    "errorCases": ["Error scenarios"],
    "edgeCases": ["Edge cases"],
    "notCovered": ["What might be missing"]
  }
}`;

const TEST_ANALYSIS_SYSTEM_PROMPT = `You are a test quality expert. Analyze tests and return JSON:

{
  "quality": "excellent|good|adequate|poor",
  "score": 1-10,
  "coverage": {
    "statements": "estimated %",
    "branches": "estimated %",
    "functions": "estimated %"
  },
  "strengths": ["What's good about these tests"],
  "weaknesses": ["What's missing or could be improved"],
  "suggestions": [
    {
      "type": "coverage|quality|performance|maintainability",
      "description": "What to improve",
      "example": "Example of how to improve"
    }
  ],
  "missingTests": ["Test cases that should be added"]
}`;

// ============================================
// Helper Functions
// ============================================

interface CodeAnalysis {
  functions: string[];
  classes: string[];
  exports: string[];
  imports: string[];
  estimatedComplexity: string;
}

function analyzeCodeStructure(code: string): CodeAnalysis {
  const functionMatches =
    code.match(/(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s*)?\(|[(<])/g) || [];
  const classMatches = code.match(/class\s+(\w+)/g) || [];
  const exportMatches =
    code.match(/export\s+(?:default\s+)?(?:function|const|class|let|var|async)?\s*(\w+)/g) || [];
  const importMatches = code.match(/import\s+.*from\s+['"](.+)['"]/g) || [];

  const lines = code.split('\n').length;
  let complexity = 'low';
  if (lines > 100) complexity = 'medium';
  if (lines > 300) complexity = 'high';

  return {
    functions: functionMatches
      .map((m) => m.replace(/(?:function|const|let|var|async|\s|=|\(|<)/g, ''))
      .filter(Boolean),
    classes: classMatches.map((m) => m.replace(/class\s+/, '')),
    exports: exportMatches,
    imports: importMatches,
    estimatedComplexity: complexity,
  };
}

function buildTestPrompt(
  code: string,
  filePath: string | undefined,
  framework: string,
  testType: string,
  coverage: string,
  analysis: CodeAnalysis,
  existingPatterns: string
): string {
  const fileInfo = filePath ? `File: ${filePath}\n` : '';
  const analysisInfo = `
Code Analysis:
- Functions: ${analysis.functions.join(', ') || 'none detected'}
- Classes: ${analysis.classes.join(', ') || 'none detected'}
- Exports: ${analysis.exports.length} items
- Complexity: ${analysis.estimatedComplexity}
`;

  return `${fileInfo}Generate ${coverage} ${testType} tests using ${framework}:

\`\`\`
${code}
\`\`\`

${analysisInfo}
${existingPatterns}

Generate complete, runnable test code.`;
}

function extractTestCode(response: string): string {
  const codeBlockMatch = response.match(
    /```(?:typescript|javascript|python|ts|js|py)?\n([\s\S]*?)```/
  );
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return response.trim();
}

export default router;
