/**
 * Review & testing tools module - code review, test generation, and test analysis.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the review & testing tools module with project-specific descriptions.
 */
export function createReviewTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "review_code",
      description:
        "Review code for issues, pattern violations, and improvements. Uses project patterns and ADRs for context.",
      schema: z.object({
        code: z.string().describe("Code to review"),
        filePath: z.string().optional().describe("File path for context"),
        reviewType: z
          .enum(["security", "performance", "patterns", "style", "general"])
          .optional()
          .describe("Type of review focus (default: general)"),
        diff: z
          .string()
          .optional()
          .describe("Git diff to review instead of full code"),
      }),
      annotations: TOOL_ANNOTATIONS["review_code"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          code,
          filePath,
          reviewType = "general",
          diff,
        } = args as {
          code: string;
          filePath?: string;
          reviewType?: string;
          diff?: string;
        };

        const response = await ctx.api.post("/api/review", {
          code: code || diff,
          filePath,
          reviewType,
          diff,
        });

        const { review, context } = response.data;

        let result = `# Code Review\n\n`;

        if (review.score) {
          result += `**Score**: ${review.score}/10\n\n`;
        }

        if (review.summary) {
          result += `## Summary\n${review.summary}\n\n`;
        }

        if (review.issues && review.issues.length > 0) {
          result += `## Issues Found\n`;
          review.issues.forEach(
            (
              issue: {
                severity: string;
                type: string;
                description: string;
                line?: number;
                suggestion?: string;
              },
              i: number,
            ) => {
              const icon =
                issue.severity === "critical"
                  ? "\u{1F6A8}"
                  : issue.severity === "high"
                    ? "\u26A0\uFE0F"
                    : issue.severity === "medium"
                      ? "\u{1F4CB}"
                      : "\u2139\uFE0F";
              result += `\n### ${icon} ${i + 1}. ${issue.type} (${issue.severity})\n`;
              result += `${issue.description}\n`;
              if (issue.line) result += `- Line: ${issue.line}\n`;
              if (issue.suggestion) result += `- Fix: ${issue.suggestion}\n`;
            },
          );
          result += "\n";
        }

        if (review.positives && review.positives.length > 0) {
          result += `## Positives\n`;
          review.positives.forEach((p: string) => {
            result += `- ${p}\n`;
          });
          result += "\n";
        }

        if (review.suggestions && review.suggestions.length > 0) {
          result += `## Suggestions\n`;
          review.suggestions.forEach((s: string) => {
            result += `- ${s}\n`;
          });
        }

        result += `\n---\n_Context: ${context.patternsUsed} patterns, ${context.adrsUsed} ADRs, ${context.similarFilesFound} similar files_`;

        return result;
      },
    },
    {
      name: "generate_tests",
      description:
        "Generate unit/integration tests based on code and existing test patterns in the project.",
      schema: z.object({
        code: z.string().describe("Code to generate tests for"),
        filePath: z.string().optional().describe("File path for context"),
        framework: z
          .enum(["jest", "vitest", "pytest", "mocha"])
          .optional()
          .describe("Test framework to use (default: jest)"),
        testType: z
          .enum(["unit", "integration", "e2e"])
          .optional()
          .describe("Type of tests to generate (default: unit)"),
        coverage: z
          .enum(["minimal", "standard", "comprehensive"])
          .optional()
          .describe("Coverage level (default: comprehensive)"),
      }),
      annotations: TOOL_ANNOTATIONS["generate_tests"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          code,
          filePath,
          framework = "jest",
          testType = "unit",
          coverage = "comprehensive",
        } = args as {
          code: string;
          filePath?: string;
          framework?: string;
          testType?: string;
          coverage?: string;
        };

        const response = await ctx.api.post("/api/generate-tests", {
          code,
          filePath,
          framework,
          testType,
          coverage,
        });

        const { tests, analysis, existingPatternsFound } = response.data;

        let result = `# Generated Tests\n\n`;
        result += `**Framework**: ${framework}\n`;
        result += `**Type**: ${testType}\n`;
        result += `**Coverage**: ${coverage}\n`;
        result += `**Existing patterns found**: ${existingPatternsFound}\n\n`;

        if (analysis) {
          result += `## Code Analysis\n`;
          result += `- Functions: ${analysis.functions?.join(", ") || "none"}\n`;
          result += `- Classes: ${analysis.classes?.join(", ") || "none"}\n`;
          result += `- Complexity: ${analysis.estimatedComplexity}\n\n`;
        }

        result += `## Generated Test Code\n\n`;
        result +=
          "```" + (framework === "pytest" ? "python" : "typescript") + "\n";
        result += tests;
        result += "\n```\n";

        return result;
      },
    },
    {
      name: "analyze_tests",
      description: "Analyze existing tests for coverage and quality.",
      schema: z.object({
        testCode: z.string().describe("Test code to analyze"),
        sourceCode: z
          .string()
          .optional()
          .describe("Optional source code being tested"),
      }),
      annotations: TOOL_ANNOTATIONS["analyze_tests"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { testCode, sourceCode } = args as {
          testCode: string;
          sourceCode?: string;
        };

        const response = await ctx.api.post("/api/analyze-tests", {
          testCode,
          sourceCode,
        });

        const { analysis } = response.data;

        let result = `# Test Analysis\n\n`;

        if (analysis.quality) {
          result += `**Quality**: ${analysis.quality}`;
          if (analysis.score) result += ` (${analysis.score}/10)`;
          result += "\n\n";
        }

        if (analysis.coverage) {
          result += `## Coverage Estimates\n`;
          Object.entries(analysis.coverage).forEach(([key, value]) => {
            result += `- ${key}: ${value}\n`;
          });
          result += "\n";
        }

        if (analysis.strengths && analysis.strengths.length > 0) {
          result += `## Strengths\n`;
          (analysis.strengths as string[]).forEach((s: string) => {
            result += `- ${s}\n`;
          });
          result += "\n";
        }

        if (analysis.weaknesses && analysis.weaknesses.length > 0) {
          result += `## Weaknesses\n`;
          (analysis.weaknesses as string[]).forEach((w: string) => {
            result += `- ${w}\n`;
          });
          result += "\n";
        }

        if (analysis.missingTests && analysis.missingTests.length > 0) {
          result += `## Missing Tests\n`;
          (analysis.missingTests as string[]).forEach((t: string) => {
            result += `- ${t}\n`;
          });
        }

        return result;
      },
    },
  ];
}
