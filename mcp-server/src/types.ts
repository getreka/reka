/**
 * Shared types for the MCP server tool modules.
 */

import type { AxiosInstance } from "axios";
import type { ZodObject, ZodRawShape } from "zod";
import type { ToolAnnotations } from "./annotations.js";

/** MCP tool input schema shape (raw JSON Schema) */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** MCP tool definition */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
}

/** Context passed to every tool handler */
export interface ToolContext {
  api: AxiosInstance;
  projectName: string;
  projectPath: string;
  collectionPrefix: string;
  activeSessionId?: string;
  enrichmentEnabled: boolean;
}

/** A tool handler function */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<string>;

/** A tool module exports definitions and handlers */
export interface ToolModule {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

/** Phase 3 tool spec: schema + handler colocated per tool */
export interface ToolSpec {
  name: string;
  description: string;
  schema: ZodObject<ZodRawShape>;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}
