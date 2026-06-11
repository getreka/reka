/**
 * Validation Schemas - Zod schemas for API input validation
 */

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ============================================
// Common Schemas
// ============================================

export const projectNameSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9_-]+$/i, {
    message: 'Project name must contain only alphanumeric characters, dashes, and underscores',
  });

export const collectionNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/i);

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
  filters: z
    .object({
      language: z.string().optional(),
      path: z.string().optional(),
      layer: z.string().optional(),
      service: z.string().optional(),
    })
    .optional(),
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
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      })
    )
    .min(1)
    .max(100),
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
  'procedure',
]);

export const todoStatusSchema = z.enum(['pending', 'in_progress', 'done', 'cancelled']);

export const pinScopeSchema = z.enum(['repo', 'all', 'unpinned']);

export const createMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  content: z.string().min(1).max(50000),
  type: memoryTypeSchema.default('note'),
  tags: z.array(z.string().max(50)).max(20).optional(),
  relatedTo: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Trigger descriptions: separate "what to recall" (content) from
  // "when to recall it" (triggerDescription). When present, the trigger cue is
  // embedded/indexed so recall can match the QUERY against it too.
  triggerDescription: z.string().max(2000).optional(),
  // Optional pin scope controlling which surfaces this memory always loads in.
  pin: pinScopeSchema.optional(),
});

export const factCategorySchema = z.enum([
  'personal_info',
  'preference',
  'event',
  'temporal',
  'update',
  'plan',
]);

export const batchItemSchema = z.object({
  content: z.string().min(1).max(50000),
  type: memoryTypeSchema.optional().default('note'),
  tags: z.array(z.string().max(50)).max(20).optional(),
  relatedTo: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  factCategory: factCategorySchema.optional(),
  factEntities: z.array(z.string().max(200)).max(50).optional(),
  factDateTs: z.number().optional(),
  triggerDescription: z.string().max(2000).optional(),
  pin: pinScopeSchema.optional(),
});

export const batchCreateMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  items: z.array(batchItemSchema).min(1).max(100),
});

export const recallMemorySchema = z.object({
  projectName: projectNameSchema.optional(),
  query: z.string().min(1).max(5000),
  type: z.union([memoryTypeSchema, z.literal('all')]).default('all'),
  limit: limitSchema.optional(),
  tag: z.string().max(50).optional(),
  graphRecall: z.boolean().optional(), // Phase 4: spreading activation
  ragFusion: z.boolean().optional(), // RAG-Fusion: multi-query + RRF merge
  recencyBoost: z.number().min(0).max(1).optional(), // Recency boost weight (0-1)
  multiStrategy: z.boolean().optional(), // TEMPR: semantic + keyword + temporal RRF fusion
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
// Memory Versioning Schemas
// ============================================

export const listMemoryVersionsSchema = z.object({
  projectName: projectNameSchema.optional(),
  memoryId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const rollbackMemoryVersionSchema = z.object({
  projectName: projectNameSchema.optional(),
});

export const redactMemoryVersionSchema = z.object({
  projectName: projectNameSchema.optional(),
});

// ============================================
// Additional Schemas
// ============================================

export const searchHybridSchema = z.object({
  collection: collectionNameSchema,
  query: z.string().min(1).max(10000),
  limit: z.number().int().min(1).max(100).default(10),
  semanticWeight: z.number().min(0).max(1).default(0.7),
  mode: searchModeSchema,
  filters: z
    .object({
      language: z.string().optional(),
      path: z.string().optional(),
      layer: z.string().optional(),
      service: z.string().optional(),
    })
    .optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================
// Sensory Buffer & Working Memory Schemas
// ============================================

export const sensoryAppendSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().min(1).max(100),
  toolName: z.string().min(1).max(100),
  inputSummary: z.string().max(500).default(''),
  outputSummary: z.string().max(500).default(''),
  filesTouched: z.array(z.string().max(500)).max(50).default([]),
  success: z.boolean(),
  durationMs: z.number().int().min(0),
});

export const consolidateSchema = z.object({
  projectName: projectNameSchema.optional(),
  sessionId: z.string().min(1).max(100),
  timeout: z.number().int().min(1000).max(300000).optional(),
});

export const semanticSubtypeSchema = z.enum(['decision', 'insight', 'pattern', 'procedure']);

// ============================================
// Validation Middleware
// ============================================

export type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Create a validation middleware for a Zod schema.
 * Forwards ZodErrors to the global error handler.
 */
export function validate<T extends z.ZodType>(schema: T, target: ValidationTarget = 'body') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = target === 'body' ? req.body : target === 'query' ? req.query : req.params;

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
export function validateProjectName(req: Request, res: Response, next: NextFunction) {
  const projectName =
    (req.headers['x-project-name'] as string) ||
    req.body?.projectName ||
    (req.query?.projectName as string);

  if (!projectName) {
    return res.status(400).json({
      error: 'projectName is required (via X-Project-Name header or body/query)',
    });
  }

  const result = projectNameSchema.safeParse(projectName);
  if (!result.success) {
    return res.status(400).json({
      error: 'Invalid project name',
      details: result.error.issues,
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

// Note: legacy op flags (e.g. `feedback_maintenance`, removed with the feedback
// service) are tolerated and silently stripped — zod objects drop unknown keys.
// Keep this tolerance until mcp 0.5.0 stops sending the option.
export const maintenanceSchema = z.object({
  projectName: projectNameSchema.optional(),
  operations: z
    .object({
      quarantine_cleanup: z.boolean().default(true),
      compaction: z.boolean().default(false),
      compaction_dry_run: z.boolean().default(true),
    })
    .optional(),
});

export const forgetOlderThanSchema = z.object({
  projectName: projectNameSchema.optional(),
  olderThanDays: z.number().int().min(1).max(365),
});

export const behaviorPatternsSchema = z.object({
  projectName: projectNameSchema.optional(),
  days: z.number().int().min(1).max(90).default(7),
  sessionId: z.string().optional(),
});

// ============================================
// Tribunal Schemas
// ============================================

export const tribunalDebateSchema = z.object({
  projectName: projectNameSchema.optional(),
  topic: z.string().min(1).max(5000),
  positions: z.array(z.string().min(1).max(1000)).min(2).max(4),
  context: z.string().max(50000).optional(),
  maxRounds: z.number().int().min(1).max(3).default(1),
  useCodeContext: z.boolean().default(false),
  autoRecord: z.boolean().default(false),
  maxBudget: z.number().min(0.01).max(5).default(0.5),
  deepResearch: z.boolean().default(false),
});

export type TribunalDebateInput = z.infer<typeof tribunalDebateSchema>;

export const tribunalHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  topic: z.string().max(1000).optional(),
});

export type TribunalHistoryInput = z.infer<typeof tribunalHistorySchema>;

// ============================================
// Agent Schemas
// ============================================

export const runAgentSchema = z.object({
  projectName: projectNameSchema.optional(),
  agentType: z.enum(['research', 'review', 'documentation', 'refactor', 'test']),
  task: z.string().min(1).max(10000),
  context: z.string().max(50000).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
  timeout: z.number().int().min(5000).max(300000).optional(),
  includeThinking: z.boolean().optional(),
});

export type RunAgentInput = z.infer<typeof runAgentSchema>;

export const autonomousAgentSchema = z.object({
  projectName: projectNameSchema.optional(),
  projectPath: z.string().min(1).max(1000),
  type: z.enum(['research', 'review', 'implement', 'test', 'refactor']),
  task: z.string().min(1).max(10000),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxBudgetUsd: z.number().min(0.01).max(50).optional(),
  model: z.string().max(100).optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  includeStreaming: z.boolean().optional(),
});

export type AutonomousAgentInput = z.infer<typeof autonomousAgentSchema>;

export const stopAutonomousAgentSchema = z.object({
  agentId: z.string().uuid(),
});

export const workflowSchema = z.object({
  projectName: projectNameSchema.optional(),
  projectPath: z.string().min(1).max(1000),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        type: z.enum(['smart_dispatch', 'agent', 'tribunal', 'claude_agent']),
        config: z.record(z.string(), z.unknown()),
        parallel: z.string().max(50).optional(),
      })
    )
    .min(1)
    .max(20),
});

export type WorkflowInput = z.infer<typeof workflowSchema>;

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
export type IndexInput = z.infer<typeof indexSchema>;
export type IndexUploadInput = z.infer<typeof indexUploadSchema>;
export type IndexConfluenceInput = z.infer<typeof indexConfluenceSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type RecallMemoryInput = z.infer<typeof recallMemorySchema>;
export type ListMemoryInput = z.infer<typeof listMemorySchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
