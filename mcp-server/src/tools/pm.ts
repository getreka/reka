/**
 * PM tools module - Product Management, requirements analysis, feature estimation,
 * spec generation, and project status tools.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { truncate, pct, paginationFooter } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the PM tools module with project-specific descriptions.
 */
export function createPmTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "search_requirements",
      description: `Search technical requirements and product documentation for ${projectName}. Finds relevant requirements, user stories, and specifications from Confluence.`,
      schema: z.object({
        query: z.string().describe("Search query for requirements (e.g., 'video inspection flow', 'payment integration')"),
        limit: z.number().optional().describe("Max results (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["search_requirements"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        const response = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query,
          limit,
        });
        const results = response.data.results;
        if (!results || results.length === 0) {
          return "No requirements found. Make sure Confluence documentation is indexed.";
        }
        return (
          `**Requirements Search: "${query}"**\n\n` +
          results
            .map(
              (r: any, i: number) =>
                `### ${i + 1}. ${r.title || "Requirement"}\n` +
                `**Relevance:** ${pct(r.score)}\n` +
                `**Source:** ${r.url || "Confluence"}\n\n` +
                truncate(r.content, 800)
            )
            .join("\n\n---\n\n")
        );
      },
    },
    {
      name: "analyze_requirements",
      description: `Analyze technical requirements and compare with existing implementation in ${projectName}. Identifies gaps, missing features, and implementation status.`,
      schema: z.object({
        feature: z.string().describe("Feature or requirement to analyze (e.g., 'video inspection', 'notifications')"),
        detailed: z.boolean().optional().describe("Include detailed code references (default: false)"),
      }),
      annotations: TOOL_ANNOTATIONS["analyze_requirements"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { feature, detailed = false } = args as {
          feature: string;
          detailed?: boolean;
        };

        // Search requirements in Confluence
        const reqResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query: feature,
          limit: 5,
        });

        // Search implementation in codebase
        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: feature,
          limit: detailed ? 10 : 5,
        });

        const requirements = reqResponse.data.results || [];
        const implementations = codeResponse.data.results || [];

        let result = `# Requirements Analysis: ${feature}\n\n`;

        result += `## Documented Requirements (${requirements.length} found)\n\n`;
        if (requirements.length === 0) {
          result += "_No documented requirements found in Confluence._\n\n";
        } else {
          requirements.forEach((r: any, i: number) => {
            result += `### ${i + 1}. ${r.title || "Requirement"}\n`;
            result += truncate(r.content, 400) + "\n\n";
          });
        }

        result += `## Implementation Status (${implementations.length} files found)\n\n`;
        if (implementations.length === 0) {
          result += "_No implementation found in codebase._\n\n";
        } else {
          implementations.forEach((r: any) => {
            result += `- **${r.file}** (${pct(r.score)} match)\n`;
            if (detailed) {
              result +=
                "```" +
                (r.language || "") +
                "\n" +
                truncate(r.content, 300) +
                "\n```\n";
            }
          });
        }

        result += `\n## Summary\n`;
        result += `- Requirements documented: ${requirements.length > 0 ? "Yes" : "No"}\n`;
        result += `- Implementation found: ${implementations.length > 0 ? "Yes" : "No"}\n`;

        if (requirements.length > 0 && implementations.length === 0) {
          result += `\n**Gap detected:** Requirements exist but no implementation found.`;
        } else if (requirements.length === 0 && implementations.length > 0) {
          result += `\n**Warning:** Implementation exists but no documented requirements.`;
        }

        return result;
      },
    },
    {
      name: "estimate_feature",
      description: `Estimate development effort for a feature based on requirements and codebase analysis. Returns complexity assessment, affected files, and risk factors.`,
      schema: z.object({
        feature: z.string().describe("Feature description to estimate"),
        includeSubtasks: z.boolean().optional().describe("Break down into subtasks (default: true)"),
      }),
      annotations: TOOL_ANNOTATIONS["estimate_feature"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { feature, includeSubtasks = true } = args as {
          feature: string;
          includeSubtasks?: boolean;
        };

        // Search for related requirements
        const reqResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query: feature,
          limit: 5,
        });

        // Search for related code
        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: feature,
          limit: 15,
        });

        // Search for related tests
        const testResponse = await ctx.api
          .post("/api/search", {
            collection: `${ctx.collectionPrefix}codebase`,
            query: `${feature} test spec`,
            limit: 10,
            filter: { must: [{ key: "file", match: { text: "test" } }] },
          })
          .catch(() => ({ data: { results: [] } }));

        const requirements = reqResponse.data.results || [];
        const relatedCode = codeResponse.data.results || [];
        const relatedTests = testResponse.data.results || [];

        // Analyze complexity based on findings
        const hasRequirements = requirements.length > 0;
        const hasExistingCode = relatedCode.length > 0;
        const hasTests = relatedTests.length > 0;
        const affectedFiles = Array.from(
          new Set(relatedCode.map((r: any) => r.payload?.file || r.file))
        ) as string[];
        const testFiles = Array.from(
          new Set(relatedTests.map((r: any) => r.payload?.file || r.file))
        ) as string[];

        // Advanced code complexity analysis
        let totalComplexityScore = 0;
        let totalIntegrationPoints = 0;
        const integrations = new Set<string>();
        const complexFunctions: string[] = [];

        for (const result of relatedCode) {
          const content = result.payload?.content || result.content || "";

          // Count complexity indicators
          const ifCount = (content.match(/\bif\s*\(/g) || []).length;
          const elseCount = (content.match(/\belse\b/g) || []).length;
          const switchCount = (content.match(/\bswitch\s*\(/g) || []).length;
          const forCount = (content.match(/\bfor\s*\(/g) || []).length;
          const whileCount = (content.match(/\bwhile\s*\(/g) || []).length;
          const tryCount = (content.match(/\btry\s*\{/g) || []).length;
          const asyncCount = (content.match(/\basync\b/g) || []).length;
          const awaitCount = (content.match(/\bawait\b/g) || []).length;

          // Cyclomatic complexity approximation
          const complexity =
            1 + ifCount + elseCount + switchCount + forCount + whileCount + tryCount;
          totalComplexityScore += complexity;

          // Track complex functions (rough estimate)
          if (complexity > 10) {
            const funcMatch = content.match(
              /(?:function|const|async)\s+(\w+)/
            );
            if (funcMatch) {
              complexFunctions.push(
                `${result.payload?.file || result.file}: ${funcMatch[1]}() - complexity ~${complexity}`
              );
            }
          }

          // Analyze integration points
          const imports =
            content.match(/import\s+.*from\s+['"]([^'"]+)['"]/g) || [];
          const requires =
            content.match(/require\s*\(['"]([^'"]+)['"]\)/g) || [];
          const apiCalls =
            content.match(/(?:axios|fetch|http|api)\.[a-z]+\(/gi) || [];
          const dbOps =
            content.match(
              /(?:prisma|mongoose|sequelize|knex|db)\.[a-z]+/gi
            ) || [];
          const externalServices =
            content.match(
              /(?:redis|kafka|rabbitmq|queue|cache)\.[a-z]+/gi
            ) || [];

          [...imports, ...requires].forEach((imp) => {
            const match = imp.match(/['"]([^'"]+)['"]/);
            if (match && !match[1].startsWith(".")) {
              integrations.add(`Package: ${match[1]}`);
            }
          });

          if (apiCalls.length > 0) integrations.add("HTTP/API calls");
          if (dbOps.length > 0) integrations.add("Database operations");
          if (externalServices.length > 0)
            integrations.add("External services (cache/queue)");
          if (asyncCount > 3 || awaitCount > 3)
            integrations.add("Heavy async operations");

          totalIntegrationPoints +=
            imports.length + requires.length + apiCalls.length + dbOps.length;
        }

        // Determine complexity level
        const avgComplexity =
          affectedFiles.length > 0
            ? totalComplexityScore / relatedCode.length
            : 0;
        let complexity = "Low";
        let complexityScore = 0;

        // Factor 1: File count (0-30 points)
        if (affectedFiles.length > 15) complexityScore += 30;
        else if (affectedFiles.length > 8) complexityScore += 20;
        else if (affectedFiles.length > 3) complexityScore += 10;
        else complexityScore += 5;

        // Factor 2: Code complexity (0-30 points)
        if (avgComplexity > 15) complexityScore += 30;
        else if (avgComplexity > 8) complexityScore += 20;
        else if (avgComplexity > 4) complexityScore += 10;
        else complexityScore += 5;

        // Factor 3: Integration points (0-20 points)
        if (integrations.size > 6) complexityScore += 20;
        else if (integrations.size > 3) complexityScore += 15;
        else if (integrations.size > 1) complexityScore += 10;
        else complexityScore += 5;

        // Factor 4: Test coverage (0-20 points) - less tests = more risk
        const testRatio =
          affectedFiles.length > 0
            ? testFiles.length / affectedFiles.length
            : 0;
        if (testRatio < 0.2) complexityScore += 20;
        else if (testRatio < 0.5) complexityScore += 15;
        else if (testRatio < 0.8) complexityScore += 10;
        else complexityScore += 5;

        if (complexityScore >= 70) complexity = "Very High";
        else if (complexityScore >= 50) complexity = "High";
        else if (complexityScore >= 30) complexity = "Medium";
        else complexity = "Low";

        // Risk assessment
        const riskFactors: string[] = [];
        let riskScore = 0;

        if (!hasRequirements) {
          riskFactors.push("No documented requirements - scope unclear");
          riskScore += 25;
        }
        if (affectedFiles.length > 10) {
          riskFactors.push(
            `Wide impact: ${affectedFiles.length} files affected`
          );
          riskScore += 20;
        }
        if (!hasTests) {
          riskFactors.push("No existing tests found - regression risk");
          riskScore += 20;
        }
        if (integrations.has("Database operations")) {
          riskFactors.push("Database changes - migration complexity");
          riskScore += 15;
        }
        if (integrations.has("External services (cache/queue)")) {
          riskFactors.push("External service dependencies");
          riskScore += 15;
        }
        if (complexFunctions.length > 3) {
          riskFactors.push(
            `${complexFunctions.length} complex functions to modify`
          );
          riskScore += 15;
        }
        if (!hasExistingCode) {
          riskFactors.push("New development - no patterns to follow");
          riskScore += 10;
        }

        let riskLevel = "Low";
        if (riskScore >= 60) riskLevel = "Critical";
        else if (riskScore >= 40) riskLevel = "High";
        else if (riskScore >= 20) riskLevel = "Medium";

        // Build result
        let result = `# Feature Estimation: ${feature}\n\n`;

        result += `## Overview\n`;
        result += `| Metric | Value |\n`;
        result += `|--------|-------|\n`;
        result += `| Complexity | **${complexity}** (score: ${complexityScore}/100) |\n`;
        result += `| Risk Level | **${riskLevel}** (score: ${riskScore}/100) |\n`;
        result += `| Affected Files | ${affectedFiles.length} |\n`;
        result += `| Test Files | ${testFiles.length} (ratio: ${(testRatio * 100).toFixed(0)}%) |\n`;
        result += `| Integration Points | ${integrations.size} |\n`;
        result += `| Avg Cyclomatic Complexity | ${avgComplexity.toFixed(1)} |\n`;
        result += `| Requirements Documented | ${hasRequirements ? "Yes" : "No"} |\n\n`;

        if (integrations.size > 0) {
          result += `## Integration Points\n`;
          Array.from(integrations)
            .slice(0, 10)
            .forEach((i: string) => {
              result += `- ${i}\n`;
            });
          result += "\n";
        }

        if (affectedFiles.length > 0) {
          result += `## Affected Files\n`;
          affectedFiles.slice(0, 15).forEach((f: string) => {
            const hasTest = testFiles.some((t) =>
              t.includes(f.replace(/\.(ts|js|py|go)$/, ""))
            );
            result += `- ${f} ${hasTest ? "(tested)" : "(no tests)"}\n`;
          });
          if (affectedFiles.length > 15) {
            result += `- ... and ${affectedFiles.length - 15} more\n`;
          }
          result += "\n";
        }

        if (complexFunctions.length > 0) {
          result += `## Complex Functions (may need refactoring)\n`;
          complexFunctions.slice(0, 5).forEach((f: string) => {
            result += `- ${f}\n`;
          });
          result += "\n";
        }

        result += `## Risk Factors\n`;
        if (riskFactors.length > 0) {
          riskFactors.forEach((r) => {
            result += `- ${r}\n`;
          });
        } else {
          result += `- No significant risks identified\n`;
        }
        result += "\n";

        if (includeSubtasks) {
          result += `## Suggested Subtasks\n`;
          let taskNum = 1;
          result += `${taskNum++}. Review and clarify requirements\n`;
          if (!hasRequirements) {
            result += `${taskNum++}. Document requirements\n`;
          }
          if (hasExistingCode) {
            result += `${taskNum++}. Analyze existing implementation and complexity\n`;
            if (complexFunctions.length > 0) {
              result += `${taskNum++}. Refactor complex functions if needed\n`;
            }
            result += `${taskNum++}. Plan modifications\n`;
          } else {
            result += `${taskNum++}. Design solution architecture\n`;
            result += `${taskNum++}. Implement core functionality\n`;
          }
          if (integrations.has("Database operations")) {
            result += `${taskNum++}. Create database migrations\n`;
          }
          result += `${taskNum++}. Write/update tests (target: >${affectedFiles.length} test cases)\n`;
          if (integrations.has("External services (cache/queue)")) {
            result += `${taskNum++}. Integration testing with external services\n`;
          }
          result += `${taskNum++}. Code review & QA\n`;
          result += `${taskNum++}. Documentation update\n`;
        }

        return result;
      },
    },
    {
      name: "get_feature_status",
      description: `Get implementation status of a feature by comparing requirements with codebase. Shows what's implemented, in progress, and missing.`,
      schema: z.object({
        feature: z.string().describe("Feature name to check status"),
      }),
      annotations: TOOL_ANNOTATIONS["get_feature_status"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { feature } = args as { feature: string };

        const reqResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query: feature,
          limit: 3,
        });

        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: feature,
          limit: 5,
        });

        const requirements = reqResponse.data.results || [];
        const implementations = codeResponse.data.results || [];

        let status = "Unknown";
        let statusEmoji = "?";

        if (requirements.length > 0 && implementations.length > 0) {
          status = "Implemented";
          statusEmoji = "[DONE]";
        } else if (requirements.length > 0 && implementations.length === 0) {
          status = "Planned (Not Implemented)";
          statusEmoji = "[PLANNED]";
        } else if (requirements.length === 0 && implementations.length > 0) {
          status = "Implemented (Undocumented)";
          statusEmoji = "[WARN]";
        } else {
          status = "Not Found";
          statusEmoji = "[MISSING]";
        }

        let result = `# Feature Status: ${feature}\n\n`;
        result += `## ${statusEmoji} Status: ${status}\n\n`;

        if (requirements.length > 0) {
          result += `### Requirements\n`;
          requirements.forEach((r: any) => {
            result += `- ${r.title || "Requirement"}: ${truncate(r.content, 150)}\n`;
          });
          result += "\n";
        }

        if (implementations.length > 0) {
          result += `### Implementation\n`;
          implementations.forEach((r: any) => {
            result += `- ${r.file}\n`;
          });
        }

        return result;
      },
    },
    {
      name: "list_requirements",
      description: `List all documented requirements/features for ${projectName} from Confluence. Groups by category or status.`,
      schema: z.object({
        category: z.string().optional().describe("Filter by category (optional)"),
        limit: z.number().optional().describe("Max results (default: 20)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
      }),
      annotations: TOOL_ANNOTATIONS["list_requirements"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { category, limit = 20, offset = 0 } = args as {
          category?: string;
          limit?: number;
          offset?: number;
        };

        const query = category || "requirements features specifications";
        const response = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query,
          limit,
          offset,
        });

        const results = response.data.results || [];

        if (results.length === 0) {
          return "No requirements found in Confluence. Make sure documentation is indexed.";
        }

        let result = `# ${ctx.projectName} Requirements\n\n`;
        if (category) {
          result += `**Category filter:** ${category}\n\n`;
        }
        result += `**Found:** ${results.length} items\n\n`;

        results.forEach((r: any, i: number) => {
          result += `${offset + i + 1}. **${r.title || "Untitled"}**\n`;
          result += `   ${truncate(r.content.replace(/\n/g, " "), 150)}\n`;
          if (r.url) {
            result += `   [View in Confluence](${r.url})\n`;
          }
          result += "\n";
        });

        result += paginationFooter(results.length, limit, offset);
        return result;
      },
    },
    {
      name: "ask_pm",
      description: `Ask product management questions about ${projectName}. Answers questions about requirements, features, priorities, and project status using both documentation and codebase.`,
      schema: z.object({
        question: z.string().describe("PM question (e.g., 'What features are planned for video inspection?', 'What\\'s the status of notifications?')"),
      }),
      annotations: TOOL_ANNOTATIONS["ask_pm"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { question } = args as { question: string };

        // Search both requirements and codebase for context
        const [reqResponse, codeResponse] = await Promise.all([
          ctx.api.post("/api/search", {
            collection: `${ctx.collectionPrefix}confluence`,
            query: question,
            limit: 5,
          }),
          ctx.api.post("/api/search", {
            collection: `${ctx.collectionPrefix}codebase`,
            query: question,
            limit: 3,
          }),
        ]);

        const requirements = reqResponse.data.results || [];
        const code = codeResponse.data.results || [];

        // Use LLM to answer the question with context
        try {
          const response = await ctx.api.post("/api/ask", {
            collection: `${ctx.collectionPrefix}confluence`,
            question: `As a Product Manager, answer this question about the project:\n\n${question}\n\nUse the provided context from requirements documentation.`,
          });

          let result = `# PM Question: ${question}\n\n`;
          result += `## Answer\n${response.data.answer}\n\n`;

          if (requirements.length > 0) {
            result += `## Related Documentation\n`;
            requirements.slice(0, 3).forEach((r: any) => {
              result += `- ${r.title || "Doc"}: ${truncate(r.content, 100)}\n`;
            });
          }

          if (code.length > 0) {
            result += `\n## Related Code\n`;
            code.slice(0, 3).forEach((r: any) => {
              result += `- ${r.file}\n`;
            });
          }

          return result;
        } catch {
          // Fallback without LLM
          let result = `# PM Question: ${question}\n\n`;
          result += `## Related Information\n\n`;

          if (requirements.length > 0) {
            result += `### From Requirements:\n`;
            requirements.forEach((r: any) => {
              result += `**${r.title || "Doc"}**\n${truncate(r.content, 300)}\n\n`;
            });
          }

          return result;
        }
      },
    },
    {
      name: "generate_spec",
      description: `Generate technical specification from requirements. Creates a structured spec document based on Confluence requirements and existing codebase patterns.`,
      schema: z.object({
        feature: z.string().describe("Feature to generate spec for"),
        format: z.enum(["markdown", "jira", "brief"]).optional().describe("Output format (default: markdown)"),
      }),
      annotations: TOOL_ANNOTATIONS["generate_spec"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { feature, format = "markdown" } = args as {
          feature: string;
          format?: string;
        };

        // Get requirements
        const reqResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}confluence`,
          query: feature,
          limit: 5,
        });

        // Get existing code for patterns
        const codeResponse = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}codebase`,
          query: feature,
          limit: 5,
        });

        const requirements = reqResponse.data.results || [];
        const code = codeResponse.data.results || [];

        // Build context for LLM
        const requirementsContext =
          requirements.length > 0
            ? requirements.map((r: any) => r.content).join("\n---\n")
            : "No documented requirements found.";

        const codeContext =
          code.length > 0
            ? code
                .map(
                  (c: any) =>
                    `File: ${c.file}\n${truncate(c.content, 300)}`
                )
                .join("\n---\n")
            : "No existing implementation found.";

        // Use LLM to generate real specification
        const specPrompt = `Generate a detailed technical specification for: "${feature}"

Requirements from documentation:
${requirementsContext}

Existing code context:
${codeContext}

Generate a complete specification including:
1. Overview and objectives
2. Detailed functional requirements with acceptance criteria
3. Technical approach with specific implementation details
4. API contracts (if applicable)
5. Database changes (if applicable)
6. Testing strategy
7. Rollout considerations`;

        try {
          const llmResponse = await ctx.api.post("/api/ask", {
            collection: `${ctx.collectionPrefix}codebase`,
            question: specPrompt,
          });

          let result = `# Technical Specification: ${feature}\n\n`;

          if (format === "jira") {
            // Convert to Jira format
            result = `h1. ${feature}\n\n`;
            result += llmResponse.data.answer
              .replace(/^## /gm, "h2. ")
              .replace(/^### /gm, "h3. ")
              .replace(/^- \[ \]/gm, "* [ ]")
              .replace(/^- /gm, "* ");
          } else if (format === "brief") {
            // Brief summary
            const answer = llmResponse.data.answer;
            const firstParagraph =
              answer.split("\n\n")[0] || answer.slice(0, 300);
            result = `**${feature}**\n\n${firstParagraph}\n\n`;
            result += `**Files affected:** ${code.map((c: any) => c.file).join(", ") || "New implementation"}`;
          } else {
            // Full markdown
            result += llmResponse.data.answer;

            // Add appendix with source files
            if (code.length > 0) {
              result += `\n\n---\n## Appendix: Related Files\n`;
              code.forEach((c: any) => {
                result += `- \`${c.file}\`\n`;
              });
            }
          }

          return result;
        } catch {
          // Fallback to template if LLM fails
          let result = `# Technical Specification: ${feature}\n\n`;
          result += `## 1. Overview\n${truncate(requirements[0]?.content, 500) || "_Add feature overview_"}\n\n`;
          result += `## 2. Requirements\n_LLM generation failed. Add requirements manually._\n\n`;
          result += `## 3. Affected Files\n`;
          code.forEach((c: any) => {
            result += `- \`${c.file}\`\n`;
          });
          return result;
        }
      },
    },
  ];
}
