/**
 * Validation Schemas - Zod schemas for API input validation
 */

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ============================================
// Common Schemas
// ============================================

export const projectNameSchema = z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/i, {
  message: 'Project name must contain only alphanumeric characters, dashes, and underscores',
});

export const collectionNameSchema = z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/i);

export const limitSchema = z.number().int().min(1).max(100).default(5);

// ============================================
// Search Schemas
// ============================================

export const searchModeSchema = z.enum(['content', 'navigate']).optional();

export const searchSchema = z.object({
  collection: collectionNameSchema,
  query: z.string().min(1).max(10000),
  limit: limitSchema.optional(),
  mode: searchModeSchema,
  filters: z.object({
    language: z.string().optional(),
    path: z.string().optional(),
    layer: z.string().optional(),
    service: z.string().optional(),
  }).optional(),
});

export const searchSimilarSchema = z.object({
  collection: collectionNameSchema,
  code: z.string().min(1).max(50000),
  limit: limitSchema.optional(),
});

export const askSchema = z.object({
  collection: collectionNameSchema,
  question: z.string().min(1).max(5000),
  includeThinking: z.boolean().optional(),
});

export const explainSchema = z.object({
  code: z.string().min(1).max(50000),
  collection: collectionNameSchema.optional(),
  filePath: z.string().optional(),
  includeThinking: z.boolean().optional(),
});

export const findFeatureSchema = z.object({
  collection: collectionNameSchema,
  description: z.string().min(1).max(2000),
});

// ============================================
// Index Schemas
// ============================================

export const indexSchema = z.object({
  projectName: projectNameSchema.optional(),
  path: z.string().min(1).optional(),
  force: z.boolean().default(false),
  patterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
});

export const indexUploadSchema = z.object({
  projectName: projectNameSchema.optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  })).min(1).max(100),
  force: z.boolean().default(false),
  done: z.boolean().default(false),
});

export const indexConfluenceSchema = z.object({
  projectName: projectNameSchema.optional(),
  spaceKeys: z.array(z.string()).optional(),
  pageIds: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  maxPages: z.number().int().min(1).max(5000).default(500),
  force: z.boolean().default(false),
});

export const confluenceSearchSchema = z.object({
  cql: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).default(20),
});

// ============================================
// Memory Schemas
// ============================================

export const memoryTypeSchema = z.enum([
  'decision',
  'insight',
  'context',
  'todo',
  'conversation',
  'note',
]);

export const todoStatusSchema = z.enum([
  'pending',
  'in_progress',
  'done',
  'cancelled',
]);

export const createMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  content: z.string().min(1).max(50000),
  type: memoryTypeSchema.default('note'),
  tags: z.array(z.string().max(50)).max(20).optional(),
  relatedTo: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const recallMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  query: z.string().min(1).max(5000),
  type: z.union([memoryTypeSchema, z.literal('all')]).default('all'),
  limit: limitSchema.optional(),
  tag: z.string().max(50).optional(),
});

export const promoteMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  memoryId: z.string().min(1),
  reason: z.enum(['human_validated', 'pr_merged', 'tests_passed']),
  evidence: z.string().max(2000).optional(),
  runGates: z.boolean().default(false),
  projectPath: z.string().optional(),
  affectedFiles: z.array(z.string()).optional(),
});

export const listMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  type: z.union([memoryTypeSchema, z.literal('all')]).optional(),
  tag: z.string().max(50).optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

export const updateTodoSchema = z.object({
  projectName: projectNameSchema.optional(),
  status: todoStatusSchema,
  note: z.string().max(1000).optional(),
});

// ============================================
// Additional Schemas
// ============================================

export const searchGroupedSchema = z.object({
  collection: collectionNameSchema,
  query: z.string().min(1).max(10000),
  groupBy: z.string().default('file'),
  limit: z.number().int().min(1).max(100).default(10),
  groupSize: z.number().int().min(1).max(10).default(1),
  mode: searchModeSchema,
  filters: z.object({
    language: z.string().optional(),
    path: z.string().optional(),
    layer: z.string().optional(),
    service: z.string().optional(),
  }).optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
});

export const searchHybridSchema = z.object({
  collection: collectionNameSchema,
  query: z.string().min(1).max(10000),
  limit: z.number().int().min(1).max(100).default(10),
  semanticWeight: z.number().min(0).max(1).default(0.7),
  mode: searchModeSchema,
  filters: z.object({
    language: z.string().optional(),
    path: z.string().optional(),
    layer: z.string().optional(),
    service: z.string().optional(),
  }).optional(),
});

export const reviewSchema = z.object({
  projectName: projectNameSchema.optional(),
  code: z.string().max(100000).optional(),
  diff: z.string().max(100000).optional(),
  filePath: z.string().optional(),
  reviewType: z.string().default('general'),
  includeThinking: z.boolean().optional(),
});

export const securityReviewSchema = z.object({
  code: z.string().min(1).max(100000),
  filePath: z.string().optional(),
  language: z.string().optional(),
});

export const generateTestsSchema = z.object({
  projectName: projectNameSchema.optional(),
  code: z.string().min(1).max(100000),
  filePath: z.string().optional(),
  framework: z.string().default('jest'),
  testType: z.string().default('unit'),
  coverage: z.string().default('comprehensive'),
});

export const analyzeConversationSchema = z.object({
  projectName: projectNameSchema.optional(),
  conversation: z.string().min(1).max(100000),
  context: z.string().optional(),
  autoSave: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.6),
});

export const trackUsageSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().optional(),
  toolName: z.string().min(1),
  inputSummary: z.string().default(''),
  startTime: z.number().optional(),
  resultCount: z.number().optional(),
  success: z.boolean().default(true),
  errorMessage: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const searchFeedbackSchema = z.object({
  projectName: projectNameSchema.optional(),
  queryId: z.string().min(1),
  query: z.string().min(1),
  resultId: z.string().min(1),
  resultFile: z.string().optional(),
  feedbackType: z.string().min(1),
  betterQuery: z.string().optional(),
  comment: z.string().optional(),
  sessionId: z.string().optional(),
});

export const memoryFeedbackSchema = z.object({
  projectName: projectNameSchema.optional(),
  memoryId: z.string().min(1),
  memoryContent: z.string().min(1),
  feedbackType: z.string().min(1),
  correction: z.string().optional(),
  comment: z.string().optional(),
  sessionId: z.string().optional(),
});

// ============================================
// Validation Middleware
// ============================================

export type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Create a validation middleware for a Zod schema.
 * Forwards ZodErrors to the global error handler.
 */
export function validate<T extends z.ZodType>(
  schema: T,
  target: ValidationTarget = 'body'
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = target === 'body' ? req.body :
                   target === 'query' ? req.query :
                   req.params;

      const validated = await schema.parseAsync(data);

      // Replace with validated data
      if (target === 'body') {
        req.body = validated;
      } else if (target === 'query') {
        (req as any).validatedQuery = validated;
      } else {
        (req as any).validatedParams = validated;
      }

      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

/**
 * Validate project name from headers or body
 */
export function validateProjectName(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const projectName = req.headers['x-project-name'] as string ||
                      req.body?.projectName ||
                      req.query?.projectName as string;

  if (!projectName) {
    return res.status(400).json({
      error: 'projectName is required (via X-Project-Name header or body/query)',
    });
  }

  const result = projectNameSchema.safeParse(projectName);
  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid project name',
      details: result.error.errors,
    });
  }

  // Ensure consistent access
  req.body.projectName = projectName;
  next();
}

// ============================================
// Prediction Schemas
// ============================================

export const prefetchSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().min(1),
});

export const predictionStatsSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().optional(),
});

export const trackPredictionSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().min(1),
  resource: z.string().min(1).max(5000),
  hit: z.boolean(),
});

// ============================================
// Advanced Feature Schemas
// ============================================

export const mergeMemoriesSchema = z.object({
  projectName: projectNameSchema.optional(),
  type: z.union([memoryTypeSchema, z.literal('all')]).default('all'),
  threshold: z.number().min(0.5).max(1).default(0.9),
  dryRun: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
});

export const completionContextSchema = z.object({
  projectName: projectNameSchema.optional(),
  currentFile: z.string().min(1),
  currentCode: z.string().min(1).max(50000),
  language: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export const importSuggestionsSchema = z.object({
  projectName: projectNameSchema.optional(),
  currentFile: z.string().min(1),
  currentCode: z.string().min(1).max(50000),
  language: z.string().optional(),
  limit: z.number().int().min(1).max(30).default(10),
});

export const typeContextSchema = z.object({
  projectName: projectNameSchema.optional(),
  typeName: z.string().max(200).optional(),
  code: z.string().max(50000).optional(),
  currentFile: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export const behaviorPatternsSchema = z.object({
  projectName: projectNameSchema.optional(),
  days: z.number().int().min(1).max(90).default(7),
  sessionId: z.string().optional(),
});

// ============================================
// PM Schemas
// ============================================

export const estimateFeatureSchema = z.object({
  projectName: projectNameSchema.optional(),
  feature: z.string().min(1).max(5000),
  includeSubtasks: z.boolean().default(true),
});

export type EstimateFeatureInput = z.infer<typeof estimateFeatureSchema>;

// ============================================
// Agent Schemas
// ============================================

export const runAgentSchema = z.object({
  projectName: projectNameSchema.optional(),
  agentType: z.enum(['research', 'review', 'documentation', 'refactor', 'test']),
  task: z.string().min(1).max(10000),
  context: z.string().max(50000).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  timeout: z.number().int().min(5000).max(300000).optional(),
  includeThinking: z.boolean().optional(),
});

export type RunAgentInput = z.infer<typeof runAgentSchema>;

// ============================================
// Context Pack Schemas
// ============================================

export const contextPackSchema = z.object({
  projectName: projectNameSchema,
  query: z.string().min(1).max(10000),
  maxTokens: z.number().int().min(500).max(32000).default(8000),
  semanticWeight: z.number().min(0).max(1).default(0.7),
  includeADRs: z.boolean().default(true),
  includeTests: z.boolean().default(false),
  graphExpand: z.boolean().default(true),
});

export type ContextPackInput = z.infer<typeof contextPackSchema>;

export const smartDispatchSchema = z.object({
  projectName: projectNameSchema.optional(),
  task: z.string().min(1).max(5000),
  files: z.array(z.string()).optional(),
  intent: z.enum(['code', 'research', 'debug', 'review', 'architecture']).optional(),
});

export type SmartDispatchInput = z.infer<typeof smartDispatchSchema>;

// Type exports for use in routes
export type SearchInput = z.infer<typeof searchSchema>;
export type SearchSimilarInput = z.infer<typeof searchSimilarSchema>;
export type AskInput = z.infer<typeof askSchema>;
export type ExplainInput = z.infer<typeof explainSchema>;
export type FindFeatureInput = z.infer<typeof findFeatureSchema>;
export type IndexInput = z.infer<typeof indexSchema>;
export type IndexUploadInput = z.infer<typeof indexUploadSchema>;
export type IndexConfluenceInput = z.infer<typeof indexConfluenceSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type RecallMemoryInput = z.infer<typeof recallMemorySchema>;
export type ListMemoryInput = z.infer<typeof listMemorySchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
