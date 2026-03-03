/**
 * Code Review Routes - AI-powered code review and analysis
 */

import { Router, Request, Response } from 'express';
import { vectorStore } from '../services/vector-store';
import { embeddingService } from '../services/embedding';
import { llm } from '../services/llm';
import { memoryService } from '../services/memory';
import { asyncHandler } from '../middleware/async-handler';
import { validate, validateProjectName, reviewSchema, securityReviewSchema } from '../utils/validation';

const router = Router();

/**
 * Review code for issues and improvements
 * POST /api/review
 */
router.post('/review', validateProjectName, validate(reviewSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, code, diff, filePath, reviewType, includeThinking } = req.body;

  if (!code && !diff) {
    return res.status(400).json({ error: 'code or diff is required' });
  }

  const codeToReview = code || diff;
  const collectionName = `${projectName}_codebase`;

  // 1. Get relevant patterns from memory
  const patterns = await memoryService.recall({
    projectName,
    query: `code patterns best practices ${filePath || 'general'}`,
    type: 'context',
    limit: 5,
  });

  // 2. Get relevant ADRs (architectural decisions)
  const adrs = await memoryService.recall({
    projectName,
    query: `architecture decision ${filePath || codeToReview.slice(0, 200)}`,
    type: 'decision',
    limit: 3,
  });

  // 3. Get similar code for comparison
  const codeEmbedding = await embeddingService.embed(codeToReview);
  const similarCode = await vectorStore.search(collectionName, codeEmbedding, 5);

  // 4. Build context for LLM
  const patternContext = patterns.length > 0
    ? `\n\nProject Patterns:\n${patterns.map(p => `- ${p.memory.content}`).join('\n')}`
    : '';

  const adrContext = adrs.length > 0
    ? `\n\nArchitectural Decisions:\n${adrs.map(a => `- ${a.memory.content}`).join('\n')}`
    : '';

  const similarContext = similarCode.length > 0
    ? `\n\nSimilar Code in Project:\n${similarCode.map(s => `File: ${s.payload.file}\n\`\`\`\n${(s.payload.content as string).slice(0, 300)}\n\`\`\``).join('\n')}`
    : '';

  // 5. Generate review
  const reviewPrompt = buildReviewPrompt(reviewType, codeToReview, filePath, patternContext, adrContext, similarContext);

  const result = await llm.complete(reviewPrompt, {
    systemPrompt: CODE_REVIEW_SYSTEM_PROMPT,
    maxTokens: 3000,
    temperature: 0.3,
    format: 'json',
  });

  // Parse structured response
  let review;
  try {
    review = JSON.parse(result.text);
  } catch {
    review = {
      summary: result.text,
      issues: [],
      suggestions: [],
      score: null,
    };
  }

  res.json({
    review,
    context: {
      patternsUsed: patterns.length,
      adrsUsed: adrs.length,
      similarFilesFound: similarCode.length,
    },
    ...(includeThinking && result.thinking ? { thinking: result.thinking } : {}),
  });
}));

/**
 * Analyze code for security issues
 * POST /api/review/security
 */
router.post('/review/security', validate(securityReviewSchema), asyncHandler(async (req: Request, res: Response) => {
  const { code, language } = req.body;

  const result = await llm.complete(
    `Analyze the following ${language || 'code'} for security vulnerabilities:\n\n\`\`\`\n${code}\n\`\`\``,
    {
      systemPrompt: SECURITY_REVIEW_SYSTEM_PROMPT,
      maxTokens: 2000,
      temperature: 0.2,
      format: 'json',
    }
  );

  let analysis;
  try {
    analysis = JSON.parse(result.text);
  } catch {
    analysis = {
      vulnerabilities: [],
      riskLevel: 'unknown',
      summary: result.text,
    };
  }

  res.json({ analysis });
}));

/**
 * Analyze code complexity
 * POST /api/review/complexity
 */
router.post('/review/complexity', asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const result = await llm.complete(
    `Analyze the complexity of this code and suggest simplifications:\n\n\`\`\`\n${code}\n\`\`\``,
    {
      systemPrompt: COMPLEXITY_REVIEW_SYSTEM_PROMPT,
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
      complexity: 'unknown',
      metrics: {},
      suggestions: [],
      summary: result.text,
    };
  }

  res.json({ analysis });
}));

// ============================================
// System Prompts
// ============================================

const CODE_REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided code and return a JSON response with:

{
  "summary": "Brief overview of the code quality",
  "score": 1-10,
  "issues": [
    {
      "severity": "critical|high|medium|low|info",
      "type": "bug|security|performance|style|maintainability",
      "description": "Description of the issue",
      "line": "Line number or range if identifiable",
      "suggestion": "How to fix it"
    }
  ],
  "positives": ["Good practices found"],
  "suggestions": ["General improvement suggestions"]
}

Be specific and actionable. Reference line numbers when possible.`;

const SECURITY_REVIEW_SYSTEM_PROMPT = `You are a security expert. Analyze code for vulnerabilities. Return JSON:

{
  "riskLevel": "critical|high|medium|low|none",
  "vulnerabilities": [
    {
      "type": "OWASP category or CVE-style name",
      "severity": "critical|high|medium|low",
      "description": "What the vulnerability is",
      "location": "Where in the code",
      "impact": "What could happen if exploited",
      "remediation": "How to fix it"
    }
  ],
  "summary": "Overall security assessment"
}

Focus on: injection, XSS, authentication, authorization, sensitive data exposure, configuration issues.`;

const COMPLEXITY_REVIEW_SYSTEM_PROMPT = `You are a software architect. Analyze code complexity. Return JSON:

{
  "complexity": "low|medium|high|very-high",
  "metrics": {
    "estimatedCyclomaticComplexity": number,
    "nestingDepth": number,
    "functionsCount": number,
    "linesOfCode": number
  },
  "hotspots": ["Areas of high complexity"],
  "suggestions": [
    {
      "area": "What to simplify",
      "currentIssue": "Why it's complex",
      "proposedChange": "How to simplify",
      "benefit": "Expected improvement"
    }
  ],
  "summary": "Overall complexity assessment"
}`;

// ============================================
// Helper Functions
// ============================================

function buildReviewPrompt(
  reviewType: string,
  code: string,
  filePath?: string,
  patternContext?: string,
  adrContext?: string,
  similarContext?: string
): string {
  const fileInfo = filePath ? `File: ${filePath}\n` : '';
  const reviewFocus = getReviewFocus(reviewType);

  return `${fileInfo}${reviewFocus}

Code to review:
\`\`\`
${code}
\`\`\`
${patternContext || ''}${adrContext || ''}${similarContext || ''}

Provide a thorough code review in JSON format.`;
}

function getReviewFocus(reviewType: string): string {
  switch (reviewType) {
    case 'security':
      return 'Focus on security vulnerabilities, input validation, and authentication.';
    case 'performance':
      return 'Focus on performance issues, inefficient algorithms, and resource usage.';
    case 'patterns':
      return 'Focus on design pattern violations and architectural consistency.';
    case 'style':
      return 'Focus on code style, naming conventions, and readability.';
    default:
      return 'Provide a comprehensive review covering bugs, security, performance, and maintainability.';
  }
}

export default router;
