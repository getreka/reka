/**
 * LLM Output Parser — Zod-based coercion for structured LLM responses.
 *
 * LLMs often return JSON with extra text, markdown fences, trailing commas,
 * or slightly wrong types. This utility:
 * 1. Extracts JSON from markdown/text wrapping
 * 2. Parses with JSON.parse
 * 3. Validates with Zod schema (coercion-friendly)
 * 4. Returns typed result or fallback default
 */

import { z, type ZodSchema } from 'zod';
import { logger } from './logger';

export interface ParseResult<T> {
  data: T;
  ok: boolean; // true if parsed+validated successfully
  raw?: string; // original text (only on failure)
  errors?: string[]; // validation errors (only on failure)
}

/**
 * Parse LLM text output into a typed object using a Zod schema.
 *
 * @param text     Raw LLM response text
 * @param schema   Zod schema to validate against
 * @param fallback Default value if parsing fails
 * @param label    Label for logging
 */
export function parseLLMOutput<T>(
  text: string,
  schema: ZodSchema<T>,
  fallback: T,
  label: string = 'llm-output'
): ParseResult<T> {
  // Step 1: Extract JSON from text
  const json = extractJSON(text);
  if (!json) {
    logger.debug(`${label}: no JSON found in LLM output`, { textLength: text.length });
    return { data: fallback, ok: false, raw: text, errors: ['No JSON found in output'] };
  }

  // Step 2: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    logger.debug(`${label}: JSON.parse failed`, { error: err.message });
    return { data: fallback, ok: false, raw: text, errors: [`JSON parse error: ${err.message}`] };
  }

  // Step 3: Validate with Zod
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { data: result.data, ok: true };
  }

  const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  logger.debug(`${label}: Zod validation failed`, { errors });
  return { data: fallback, ok: false, raw: text, errors };
}

/**
 * Parse LLM output, returning the validated data or throwing.
 */
export function parseLLMOutputStrict<T>(
  text: string,
  schema: ZodSchema<T>,
  label: string = 'llm-output'
): T {
  const result = parseLLMOutput(text, schema, undefined as T, label);
  if (!result.ok) {
    throw new Error(`Failed to parse LLM output (${label}): ${result.errors?.join('; ')}`);
  }
  return result.data;
}

/**
 * Extract JSON from LLM text — handles markdown fences, leading/trailing text.
 */
function extractJSON(text: string): string | null {
  const trimmed = text.trim();

  // Try direct parse first (most common case)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find first { or [ and match to last } or ]
  const objStart = trimmed.indexOf('{');
  const arrStart = trimmed.indexOf('[');

  if (objStart === -1 && arrStart === -1) return null;

  // Pick the earlier occurrence
  const start =
    objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);

  const isObj = trimmed[start] === '{';
  const closeChar = isObj ? '}' : ']';

  // Find matching close (last occurrence)
  const end = trimmed.lastIndexOf(closeChar);
  if (end <= start) return null;

  return trimmed.slice(start, end + 1);
}

// ── Pre-built Schemas ────────────────────────────────────────

/** Smart dispatch routing result */
export const routingSchema = z.object({
  lookups: z.array(z.string()),
  reasoning: z.string().optional(),
});

/** Conversation analysis result */
export const conversationAnalysisSchema = z.object({
  learnings: z
    .array(
      z.object({
        type: z.string(),
        content: z.string(),
        tags: z.array(z.string()).default([]),
        relatedTo: z.string().optional(),
        confidence: z.coerce.number().min(0).max(1).default(0.5),
        reasoning: z.string().optional(),
      })
    )
    .default([]),
  entities: z
    .object({
      files: z.array(z.string()).default([]),
      functions: z.array(z.string()).default([]),
      concepts: z.array(z.string()).default([]),
    })
    .default({ files: [], functions: [], concepts: [] }),
  summary: z.string().default(''),
});

/** Explain code result */
export const explainCodeSchema = z.object({
  summary: z.string().default(''),
  purpose: z.string().default(''),
  keyComponents: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});

/** Typed fact categories for human-memory extraction */
export const factCategorySchema = z.enum([
  'personal_info',
  'preference',
  'event',
  'temporal',
  'update',
  'plan',
]);
export type FactCategory = z.infer<typeof factCategorySchema>;

/** Single structured fact extracted from a conversation */
export const structuredFactSchema = z.object({
  category: factCategorySchema,
  content: z.string(),
  entities: z.array(z.string()).default([]),
  date: z.string().optional(),
  supersedes: z.string().nullable().optional(),
});
export type StructuredFactItem = z.infer<typeof structuredFactSchema>;

/** Structured fact extraction result */
export const structuredFactExtractionSchema = z.object({
  facts: z.array(structuredFactSchema).default([]),
});
