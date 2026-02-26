/**
 * Architecture tools module - ADRs, patterns, tech debt, and structure analysis.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { truncate, pct } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

export function createArchitectureTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "record_adr",
      description: `Record an Architecture Decision Record (ADR). Use this to document important architectural decisions, technology choices, and design patterns for ${projectName}.`,
      schema: z.object({
        title: z.string().describe("Short title for the decision (e.g., 'Use WebSocket for real-time updates')"),
        context: z.string().describe("Why this decision was needed - the problem or requirement"),
        decision: z.string().describe("What was decided"),
        consequences: z.string().optional().describe("Positive and negative consequences of this decision"),
        alternatives: z.string().optional().describe("What alternatives were considered"),
        status: z.enum(["proposed", "accepted", "deprecated", "superseded"]).optional().describe("Status of the decision (default: accepted)"),
        tags: z.array(z.string()).optional().describe("Tags for categorization (e.g., ['api', 'security', 'database'])"),
      }),
      annotations: TOOL_ANNOTATIONS["record_adr"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const {
          title,
          context,
          decision,
          consequences,
          alternatives,
          status = "accepted",
          tags = [],
        } = args as {
          title: string;
          context: string;
          decision: string;
          consequences?: string;
          alternatives?: string;
          status?: string;
          tags?: string[];
        };

        const adrContent = `# ADR: ${title}

## Status
${status.toUpperCase()}

## Context
${context}

## Decision
${decision}

${consequences ? `## Consequences\n${consequences}\n` : ""}
${alternatives ? `## Alternatives Considered\n${alternatives}` : ""}`;

        const response = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          content: adrContent,
          type: "decision",
          tags: ["adr", ...tags],
          relatedTo: title,
          metadata: { adrTitle: title, adrStatus: status },
        });

        return (
          `# ADR Recorded\n\n` +
          `- **ID:** ${response.data.memory.id}\n` +
          `- **Title:** ${title}\n` +
          `- **Status:** ${status}\n` +
          `- **Tags:** ${["adr", ...tags].join(", ")}\n\n` +
          `Use \`get_adrs\` to retrieve this decision later.`
        );
      },
    },

    {
      name: "get_adrs",
      description: `Get Architecture Decision Records for ${projectName}. Search by topic or list all ADRs.`,
      schema: z.object({
        query: z.string().optional().describe("Search query (optional - returns all if empty)"),
        status: z.enum(["proposed", "accepted", "deprecated", "superseded", "all"]).optional().describe("Filter by status"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_adrs"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const {
          query,
          status = "all",
          limit = 10,
        } = args as {
          query?: string;
          status?: string;
          limit?: number;
        };

        const response = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: query || "architecture decision ADR",
          type: "decision",
          limit,
          tag: "adr",
        });

        const results = response.data.results || [];
        const adrs = results.filter(
          (r: any) =>
            r.memory.tags?.includes("adr") &&
            (status === "all" || r.memory.metadata?.adrStatus === status),
        );

        if (adrs.length === 0) {
          return `No ADRs found${query ? ` for "${query}"` : ""}`;
        }

        const statusIcons: Record<string, string> = {
          proposed: "\uD83D\uDFE1",
          accepted: "\uD83D\uDFE2",
          deprecated: "\uD83D\uDD34",
          superseded: "\u26AB",
        };

        let result = `# Architecture Decision Records (${adrs.length})\n\n`;
        adrs.forEach((r: any, i: number) => {
          const m = r.memory;
          const adrStatus = (m.metadata?.adrStatus || "accepted") as string;
          const icon = statusIcons[adrStatus] || "\u26AA";

          result += `### ${i + 1}. ${icon} ${m.metadata?.adrTitle || m.relatedTo || "ADR"}\n`;
          result += `**Status:** ${adrStatus} | **ID:** \`${m.id}\`\n\n`;
          result +=
            truncate(m.content, 500) + "\n\n";
        });

        return result;
      },
    },

    {
      name: "record_pattern",
      description: `Record an architectural pattern used in ${projectName}. Patterns define how specific types of code should be structured.`,
      schema: z.object({
        name: z.string().describe("Pattern name (e.g., 'Service Layer', 'Repository Pattern', 'API Endpoint')"),
        description: z.string().describe("What this pattern is for and when to use it"),
        structure: z.string().describe("How code following this pattern should be structured (file organization, naming, etc.)"),
        example: z.string().optional().describe("Example code or file reference demonstrating the pattern"),
        appliesTo: z.string().optional().describe("Where this pattern applies (e.g., 'backend/src/modules/*', 'all API endpoints')"),
        tags: z.array(z.string()).optional().describe("Tags (e.g., ['backend', 'api', 'module'])"),
      }),
      annotations: TOOL_ANNOTATIONS["record_pattern"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const {
          name,
          description,
          structure,
          example,
          appliesTo,
          tags = [],
        } = args as {
          name: string;
          description: string;
          structure: string;
          example?: string;
          appliesTo?: string;
          tags?: string[];
        };

        const patternContent = `# Pattern: ${name}

## Description
${description}

## Structure
${structure}

${example ? `## Example\n\`\`\`\n${example}\n\`\`\`\n` : ""}
${appliesTo ? `## Applies To\n${appliesTo}` : ""}`;

        const response = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          content: patternContent,
          type: "context",
          tags: ["pattern", ...tags],
          relatedTo: name,
          metadata: { patternName: name, appliesTo },
        });

        return (
          `# Pattern Recorded\n\n` +
          `- **Name:** ${name}\n` +
          `- **ID:** ${response.data.memory.id}\n` +
          (appliesTo ? `- **Applies To:** ${appliesTo}\n` : "") +
          `- **Tags:** ${["pattern", ...tags].join(", ")}`
        );
      },
    },

    {
      name: "get_patterns",
      description: `Get architectural patterns for ${projectName}. Use to understand how to structure new code.`,
      schema: z.object({
        query: z.string().optional().describe("Search for patterns by name or description"),
        appliesTo: z.string().optional().describe("Filter by what patterns apply to (e.g., 'api', 'module')"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_patterns"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const {
          query,
          appliesTo,
          limit = 10,
        } = args as {
          query?: string;
          appliesTo?: string;
          limit?: number;
        };

        const response = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: query || "architectural pattern structure",
          type: "context",
          limit,
          tag: "pattern",
        });

        const results = response.data.results || [];
        const patterns = results.filter((r: any) => {
          const isPattern = r.memory.tags?.includes("pattern");
          const matchesAppliesTo =
            !appliesTo ||
            r.memory.metadata?.appliesTo
              ?.toLowerCase()
              .includes(appliesTo.toLowerCase());
          return isPattern && matchesAppliesTo;
        });

        if (patterns.length === 0) {
          return `No patterns found${query ? ` for "${query}"` : ""}`;
        }

        let result = `# Architectural Patterns (${patterns.length})\n\n`;
        patterns.forEach((r: any, i: number) => {
          const m = r.memory;
          result += `### ${i + 1}. ${m.metadata?.patternName || m.relatedTo || "Pattern"}\n`;
          if (m.metadata?.appliesTo) {
            result += `**Applies to:** ${m.metadata.appliesTo}\n`;
          }
          result += `**ID:** \`${m.id}\`\n\n`;
          result += truncate(m.content, 600) + "\n\n";
        });

        return result;
      },
    },

    {
      name: "check_architecture",
      description: `Check if code or a feature follows established architectural patterns. Analyzes code against recorded patterns and ADRs.`,
      schema: z.object({
        code: z.string().optional().describe("Code snippet to check"),
        filePath: z.string().optional().describe("File path for context (helps determine which patterns apply)"),
        featureDescription: z.string().optional().describe("Description of what the code does (alternative to providing code)"),
      }),
      annotations: TOOL_ANNOTATIONS["check_architecture"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { code, filePath, featureDescription } = args as {
          code?: string;
          filePath?: string;
          featureDescription?: string;
        };

        const patternQuery = filePath || featureDescription || "architectural patterns";

        // Get relevant patterns
        const patternsResponse = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: patternQuery,
          type: "context",
          limit: 5,
          tag: "pattern",
        });

        // Get relevant ADRs
        const adrsResponse = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: patternQuery,
          type: "decision",
          limit: 5,
          tag: "adr",
        });

        // Search similar code in codebase
        let similarCode: any[] = [];
        if (code) {
          const codeResponse = await ctx.api.post("/api/search", {
            collection: `${ctx.collectionPrefix}codebase`,
            query: code.slice(0, 500),
            limit: 3,
          });
          similarCode = codeResponse.data.results || [];
        }

        const patterns = (patternsResponse.data.results || []).filter(
          (r: any) => r.memory.tags?.includes("pattern"),
        );
        const adrs = (adrsResponse.data.results || []).filter(
          (r: any) => r.memory.tags?.includes("adr"),
        );

        let result = `# Architecture Check\n\n`;

        if (filePath) {
          result += `**File:** ${filePath}\n\n`;
        }
        if (featureDescription) {
          result += `**Feature:** ${featureDescription}\n\n`;
        }

        // If we have code and patterns/ADRs, perform LLM validation
        if (code && (patterns.length > 0 || adrs.length > 0)) {
          const patternRules = patterns
            .map(
              (p: any) =>
                `Pattern: ${p.memory.metadata?.patternName || p.memory.relatedTo}\nDescription: ${truncate(p.memory.content, 300)}`,
            )
            .join("\n\n");

          const adrRules = adrs
            .map(
              (a: any) =>
                `ADR: ${a.memory.metadata?.adrTitle || a.memory.relatedTo}\nDecision: ${truncate(a.memory.content, 300)}`,
            )
            .join("\n\n");

          const validationPrompt = `Analyze if this code follows the established architectural patterns and decisions.

Code to validate:
\`\`\`
${code.slice(0, 2000)}
\`\`\`

Patterns to check against:
${patternRules || "None recorded"}

Architectural Decisions (ADRs):
${adrRules || "None recorded"}

Provide a structured analysis:
1. List any violations of patterns or ADRs
2. Rate compliance (1-10)
3. Specific recommendations for improvements`;

          try {
            const validationResponse = await ctx.api.post("/api/ask", {
              collection: `${ctx.collectionPrefix}codebase`,
              question: validationPrompt,
            });

            result += `## Validation Results\n\n`;
            result += validationResponse.data.answer;
            result += "\n\n";
          } catch (_e) {
            // Continue without LLM validation
          }
        }

        result += `## Applicable Patterns (${patterns.length})\n`;
        if (patterns.length === 0) {
          result += `_No specific patterns recorded for this area._\n\n`;
        } else {
          patterns.forEach((p: any) => {
            result += `- **${p.memory.metadata?.patternName || p.memory.relatedTo}**: ${truncate(p.memory.content, 100)}\n`;
          });
          result += "\n";
        }

        result += `## Relevant ADRs (${adrs.length})\n`;
        if (adrs.length === 0) {
          result += `_No relevant architectural decisions found._\n\n`;
        } else {
          adrs.forEach((a: any) => {
            result += `- **${a.memory.metadata?.adrTitle || a.memory.relatedTo}** [${a.memory.metadata?.adrStatus || "accepted"}]: ${truncate(a.memory.content, 100)}\n`;
          });
          result += "\n";
        }

        if (similarCode.length > 0) {
          result += `## Similar Existing Code\n`;
          result += `_Review these for consistency:_\n`;
          similarCode.forEach((c: any) => {
            result += `- ${c.file}\n`;
          });
          result += "\n";
        }

        result += `## Recommendations\n`;
        if (patterns.length > 0) {
          result += `- Follow the patterns listed above for consistency\n`;
        }
        if (adrs.length > 0) {
          result += `- Ensure compliance with recorded architectural decisions\n`;
        }
        if (similarCode.length > 0) {
          result += `- Check similar code for established conventions\n`;
        }
        if (patterns.length === 0 && adrs.length === 0) {
          result += `- Consider recording patterns/ADRs for this area with \`record_pattern\` and \`record_adr\`\n`;
        }

        return result;
      },
    },

    {
      name: "suggest_architecture",
      description: `Get architectural guidance for implementing a new feature. Suggests structure, patterns to follow, and relevant ADRs.`,
      schema: z.object({
        feature: z.string().describe("Feature to implement"),
        type: z.enum(["api", "module", "service", "component", "integration", "other"]).optional().describe("Type of feature"),
      }),
      annotations: TOOL_ANNOTATIONS["suggest_architecture"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { feature, type = "other" } = args as {
          feature: string;
          type?: string;
        };

        // Get patterns for this type
        const patternsResponse = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: `${type} ${feature} pattern structure`,
          type: "context",
          limit: 5,
          tag: "pattern",
        });

        // Get relevant ADRs
        const adrsResponse = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: `${type} ${feature}`,
          type: "decision",
          limit: 3,
          tag: "adr",
        });

        // Get similar implementations
        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: `${type} ${feature}`,
          limit: 5,
        });

        const patterns = (patternsResponse.data.results || []).filter(
          (r: any) => r.memory.tags?.includes("pattern"),
        );
        const adrs = (adrsResponse.data.results || []).filter(
          (r: any) => r.memory.tags?.includes("adr"),
        );
        const existingCode = codeResponse.data.results || [];

        let result = `# Architecture Suggestion: ${feature}\n\n`;
        result += `**Type:** ${type}\n\n`;

        result += `## Recommended Patterns\n`;
        if (patterns.length === 0) {
          result += `_No specific patterns recorded. Consider following existing code conventions._\n\n`;
        } else {
          patterns.forEach((p: any) => {
            result += `### ${p.memory.metadata?.patternName || p.memory.relatedTo}\n`;
            result += truncate(p.memory.content, 400) + "\n\n";
          });
        }

        result += `## Relevant Decisions (ADRs)\n`;
        if (adrs.length === 0) {
          result += `_No specific ADRs found for this area._\n\n`;
        } else {
          adrs.forEach((a: any) => {
            result += `- **${a.memory.metadata?.adrTitle || a.memory.relatedTo}**: `;
            const decision = a.memory.content.match(
              /## Decision\n([\s\S]*?)(?=\n##|$)/,
            );
            result += decision
              ? truncate(decision[1].trim(), 150)
              : "See full ADR";
            result += "\n";
          });
          result += "\n";
        }

        result += `## Reference Implementations\n`;
        if (existingCode.length === 0) {
          result += `_No similar implementations found._\n\n`;
        } else {
          result += `_Study these for conventions:_\n`;
          existingCode.forEach((c: any) => {
            result += `- \`${c.file}\`\n`;
          });
          result += "\n";
        }

        result += `## Next Steps\n`;
        result += `1. Review the patterns and ADRs above\n`;
        result += `2. Study reference implementations for conventions\n`;
        result += `3. Create your implementation following established structure\n`;
        result += `4. Use \`check_architecture\` to validate before committing\n`;

        return result;
      },
    },

    {
      name: "record_tech_debt",
      description: `Record technical debt or architectural violation that needs to be addressed later.`,
      schema: z.object({
        title: z.string().describe("Short description of the tech debt"),
        description: z.string().describe("Detailed description of the issue"),
        location: z.string().optional().describe("Where in the codebase (file paths, modules)"),
        impact: z.enum(["low", "medium", "high", "critical"]).describe("Impact level"),
        suggestedFix: z.string().optional().describe("How to fix this debt"),
        relatedAdr: z.string().optional().describe("Related ADR ID if this violates a decision"),
      }),
      annotations: TOOL_ANNOTATIONS["record_tech_debt"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { title, description, location, impact, suggestedFix, relatedAdr } =
          args as {
            title: string;
            description: string;
            location?: string;
            impact: string;
            suggestedFix?: string;
            relatedAdr?: string;
          };

        const debtContent = `# Tech Debt: ${title}

## Impact
${impact.toUpperCase()}

## Description
${description}

${location ? `## Location\n${location}\n` : ""}
${suggestedFix ? `## Suggested Fix\n${suggestedFix}\n` : ""}
${relatedAdr ? `## Related ADR\n${relatedAdr}` : ""}`;

        const response = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          content: debtContent,
          type: "insight",
          tags: ["tech-debt", `impact-${impact}`],
          relatedTo: title,
          metadata: { debtTitle: title, impact, location },
        });

        const impactEmojis: Record<string, string> = {
          low: "\uD83D\uDFE2",
          medium: "\uD83D\uDFE1",
          high: "\uD83D\uDFE0",
          critical: "\uD83D\uDD34",
        };
        const emoji = impactEmojis[impact] || "\u26AA";

        return (
          `${emoji} **Tech Debt Recorded**\n\n` +
          `- **Title:** ${title}\n` +
          `- **Impact:** ${impact}\n` +
          `- **ID:** ${response.data.memory.id}\n` +
          (location ? `- **Location:** ${location}\n` : "")
        );
      },
    },

    {
      name: "get_tech_debt",
      description: `List technical debt items for ${projectName}.`,
      schema: z.object({
        impact: z.enum(["low", "medium", "high", "critical", "all"]).optional().describe("Filter by impact"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_tech_debt"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { impact = "all", limit = 10 } = args as {
          impact?: string;
          limit?: number;
        };

        const response = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: "technical debt violation issue",
          type: "insight",
          limit: limit * 2, // Fetch extra to account for filtering
          tag: "tech-debt",
        });

        const results = response.data.results || [];
        const debts = results
          .filter((r: any) => {
            const isDebt = r.memory.tags?.includes("tech-debt");
            const matchesImpact =
              impact === "all" ||
              r.memory.metadata?.impact === impact ||
              r.memory.tags?.includes(`impact-${impact}`);
            return isDebt && matchesImpact;
          })
          .slice(0, limit);

        if (debts.length === 0) {
          return `No tech debt found${impact !== "all" ? ` with ${impact} impact` : ""}`;
        }

        const impactEmojis: Record<string, string> = {
          low: "\uD83D\uDFE2",
          medium: "\uD83D\uDFE1",
          high: "\uD83D\uDFE0",
          critical: "\uD83D\uDD34",
        };

        let result = `# Technical Debt (${debts.length})\n\n`;
        debts.forEach((r: any, i: number) => {
          const m = r.memory;
          const debtImpact = m.metadata?.impact || "medium";
          const emoji = impactEmojis[debtImpact] || "\u26AA";

          result += `### ${i + 1}. ${emoji} ${m.metadata?.debtTitle || m.relatedTo || "Tech Debt"}\n`;
          result += `**Impact:** ${debtImpact}`;
          if (m.metadata?.location) {
            result += ` | **Location:** ${m.metadata.location}`;
          }
          result += `\n**ID:** \`${m.id}\`\n\n`;

          // Extract description section
          const descMatch = m.content.match(
            /## Description\n([\s\S]*?)(?=\n##|$)/,
          );
          if (descMatch) {
            result += truncate(descMatch[1].trim(), 200) + "\n\n";
          }
        });

        return result;
      },
    },

    {
      name: "analyze_project_structure",
      description: `Analyze the current project structure and compare with established patterns. Identifies inconsistencies and suggests improvements.`,
      schema: z.object({
        path: z.string().optional().describe("Specific path to analyze (default: entire project)"),
        deep: z.boolean().optional().describe("Perform deep analysis including code patterns (default: false)"),
      }),
      annotations: TOOL_ANNOTATIONS["analyze_project_structure"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { path, deep = false } = args as {
          path?: string;
          deep?: boolean;
        };

        // Get all recorded patterns
        const patternsResponse = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query: "pattern structure organization",
          type: "context",
          limit: 10,
          tag: "pattern",
        });

        // Get codebase structure
        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: path || "module service controller",
          limit: deep ? 20 : 10,
        });

        const patterns = (patternsResponse.data.results || []).filter(
          (r: any) => r.memory.tags?.includes("pattern"),
        );
        const codeFiles = codeResponse.data.results || [];

        // Analyze file organization by directory
        const filesByDir: Record<string, string[]> = {};
        codeFiles.forEach((c: any) => {
          const dir = c.file.split("/").slice(0, -1).join("/") || "/";
          if (!filesByDir[dir]) filesByDir[dir] = [];
          filesByDir[dir].push(c.file.split("/").pop());
        });

        let result = `# Project Structure Analysis\n\n`;

        if (path) {
          result += `**Scope:** ${path}\n\n`;
        }

        result += `## Directory Structure\n`;
        Object.entries(filesByDir)
          .slice(0, 10)
          .forEach(([dir, files]) => {
            result += `\n**${dir || "/"}/**\n`;
            files.slice(0, 5).forEach((f) => {
              result += `  - ${f}\n`;
            });
            if (files.length > 5) {
              result += `  - ... and ${files.length - 5} more\n`;
            }
          });

        result += `\n## Recorded Patterns (${patterns.length})\n`;
        if (patterns.length === 0) {
          result += `_No patterns recorded yet. Consider documenting your architectural patterns._\n\n`;
        } else {
          patterns.forEach((p: any) => {
            result += `- ${p.memory.metadata?.patternName || p.memory.relatedTo}`;
            if (p.memory.metadata?.appliesTo) {
              result += ` -> ${p.memory.metadata.appliesTo}`;
            }
            result += "\n";
          });
        }

        result += `\n## Recommendations\n`;
        if (patterns.length === 0) {
          result += `1. **Record patterns** - Use \`record_pattern\` to document how code should be structured\n`;
        }
        result += `2. **Document decisions** - Use \`record_adr\` for important architectural choices\n`;
        result += `3. **Track tech debt** - Use \`record_tech_debt\` for violations and issues\n`;
        result += `4. **Validate changes** - Use \`check_architecture\` before committing new code\n`;

        return result;
      },
    },
  ];
}
