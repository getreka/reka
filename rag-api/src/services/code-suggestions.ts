/**
 * Code Suggestion Service - Intelligent code recommendations
 *
 * Features:
 * - Find related code implementations
 * - Suggest similar patterns for reference
 * - Find test patterns for similar code
 * - Context-aware code recommendations
 */

import { vectorStore, SearchResult } from './vector-store';
import { embeddingService } from './embedding';
import { llm } from './llm';
import { logger } from '../utils/logger';

export interface CodeSuggestion {
  file: string;
  content: string;
  score: number;
  reason: string;
  startLine?: number;
  endLine?: number;
  language?: string;
}

export interface RelatedCodeResult {
  suggestions: CodeSuggestion[];
  totalFound: number;
  context: string;
}

export interface ImplementationSuggestion extends CodeSuggestion {
  patternType: 'similar_structure' | 'same_domain' | 'related_import' | 'test_pattern';
  adaptationHints?: string[];
}

export interface TestSuggestion extends CodeSuggestion {
  testType: 'unit' | 'integration' | 'e2e';
  framework?: string;
  coverage: string[];
}

class CodeSuggestionService {
  private getCodebaseCollection(projectName: string): string {
    return `${projectName}_codebase`;
  }

  /**
   * Find code related to a given code snippet or description
   */
  async findRelatedCode(options: {
    projectName: string;
    code?: string;
    description?: string;
    currentFile?: string;
    limit?: number;
    minScore?: number;
  }): Promise<RelatedCodeResult> {
    const { projectName, code, description, currentFile, limit = 10, minScore = 0.5 } = options;

    const collection = this.getCodebaseCollection(projectName);

    try {
      // Create embedding from code or description
      const searchText = code || description || '';
      if (!searchText) {
        return { suggestions: [], totalFound: 0, context: 'No search text provided' };
      }

      const embedding = await embeddingService.embed(searchText);

      // Search with optional file exclusion
      let filter: Record<string, unknown> | undefined;
      if (currentFile) {
        filter = {
          must_not: [{ key: 'file', match: { value: currentFile } }],
        };
      }

      const results = await vectorStore.search(collection, embedding, limit * 2, filter, minScore);

      // Deduplicate by file and select top results
      const fileMap = new Map<string, SearchResult>();
      for (const r of results) {
        const file = r.payload.file as string;
        if (!fileMap.has(file) || fileMap.get(file)!.score < r.score) {
          fileMap.set(file, r);
        }
      }

      const suggestions: CodeSuggestion[] = Array.from(fileMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({
          file: r.payload.file as string,
          content: r.payload.content as string,
          score: r.score,
          reason: this.generateReason(r, code, description),
          startLine: r.payload.startLine as number | undefined,
          endLine: r.payload.endLine as number | undefined,
          language: r.payload.language as string | undefined,
        }));

      return {
        suggestions,
        totalFound: results.length,
        context: code ? 'Based on code similarity' : 'Based on description match',
      };
    } catch (error: any) {
      logger.error('Failed to find related code', { error: error.message });
      return { suggestions: [], totalFound: 0, context: `Error: ${error.message}` };
    }
  }

  /**
   * Suggest implementation patterns similar to target code
   */
  async suggestImplementation(options: {
    projectName: string;
    targetCode: string;
    targetDescription?: string;
    currentFile?: string;
    limit?: number;
  }): Promise<ImplementationSuggestion[]> {
    const { projectName, targetCode, targetDescription, currentFile, limit = 5 } = options;

    const collection = this.getCodebaseCollection(projectName);

    try {
      // Create combined embedding
      const searchText = `${targetCode}\n${targetDescription || ''}`;
      const embedding = await embeddingService.embed(searchText);

      // Search with file exclusion
      let filter: Record<string, unknown> | undefined;
      if (currentFile) {
        filter = {
          must_not: [{ key: 'file', match: { value: currentFile } }],
        };
      }

      const results = await vectorStore.search(collection, embedding, limit * 3, filter, 0.6);

      // Categorize and score results
      const suggestions: ImplementationSuggestion[] = [];
      const seenFiles = new Set<string>();

      for (const r of results) {
        const file = r.payload.file as string;
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);

        const content = r.payload.content as string;
        const patternType = this.classifyPattern(targetCode, content, file);

        suggestions.push({
          file,
          content,
          score: r.score,
          reason: this.generateImplementationReason(patternType, file),
          startLine: r.payload.startLine as number | undefined,
          endLine: r.payload.endLine as number | undefined,
          language: r.payload.language as string | undefined,
          patternType,
          adaptationHints: this.generateAdaptationHints(targetCode, content),
        });

        if (suggestions.length >= limit) break;
      }

      return suggestions;
    } catch (error: any) {
      logger.error('Failed to suggest implementation', { error: error.message });
      return [];
    }
  }

  /**
   * Find test patterns for given code
   */
  async suggestTests(options: {
    projectName: string;
    code: string;
    filePath?: string;
    testType?: 'unit' | 'integration' | 'e2e';
    limit?: number;
  }): Promise<TestSuggestion[]> {
    const { projectName, code, filePath, testType, limit = 5 } = options;

    const collection = this.getCodebaseCollection(projectName);

    try {
      // Create test-focused embedding
      const searchText = `test ${code}`;
      const embedding = await embeddingService.embed(searchText);

      // Filter for test files
      const filter: Record<string, unknown> = {
        should: [
          { key: 'file', match: { text: '.test.' } },
          { key: 'file', match: { text: '.spec.' } },
          { key: 'file', match: { text: '_test.' } },
          { key: 'file', match: { text: '/tests/' } },
          { key: 'file', match: { text: '/__tests__/' } },
        ],
      };

      const results = await vectorStore.search(collection, embedding, limit * 3, filter, 0.5);

      const suggestions: TestSuggestion[] = [];
      const seenFiles = new Set<string>();

      for (const r of results) {
        const file = r.payload.file as string;
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);

        const content = r.payload.content as string;
        const detectedType = this.detectTestType(file, content);

        // Filter by requested test type if specified
        if (testType && detectedType !== testType) continue;

        suggestions.push({
          file,
          content,
          score: r.score,
          reason: `Similar ${detectedType} test pattern`,
          startLine: r.payload.startLine as number | undefined,
          endLine: r.payload.endLine as number | undefined,
          language: r.payload.language as string | undefined,
          testType: detectedType,
          framework: this.detectTestFramework(content),
          coverage: this.extractTestCoverage(content),
        });

        if (suggestions.length >= limit) break;
      }

      return suggestions;
    } catch (error: any) {
      logger.error('Failed to suggest tests', { error: error.message });
      return [];
    }
  }

  /**
   * Get comprehensive code context for a file/function
   */
  async getCodeContext(options: {
    projectName: string;
    code: string;
    includeRelated?: boolean;
    includeTests?: boolean;
    includeImports?: boolean;
  }): Promise<{
    related: CodeSuggestion[];
    tests: TestSuggestion[];
    imports: string[];
    summary: string;
  }> {
    const {
      projectName,
      code,
      includeRelated = true,
      includeTests = true,
      includeImports = true,
    } = options;

    const result = {
      related: [] as CodeSuggestion[],
      tests: [] as TestSuggestion[],
      imports: [] as string[],
      summary: '',
    };

    try {
      // Get related code
      if (includeRelated) {
        const relatedResult = await this.findRelatedCode({
          projectName,
          code,
          limit: 5,
        });
        result.related = relatedResult.suggestions;
      }

      // Get test patterns
      if (includeTests) {
        result.tests = await this.suggestTests({
          projectName,
          code,
          limit: 3,
        });
      }

      // Extract imports from code
      if (includeImports) {
        result.imports = this.extractImports(code);
      }

      // Generate summary
      result.summary = `Found ${result.related.length} related files, ${result.tests.length} test patterns`;

      return result;
    } catch (error: any) {
      logger.error('Failed to get code context', { error: error.message });
      return result;
    }
  }

  /**
   * Get code completion context - find patterns and imports from similar code
   */
  async getCompletionContext(options: {
    projectName: string;
    currentFile: string;
    currentCode: string;
    language?: string;
    limit?: number;
  }): Promise<{
    patterns: Array<{ file: string; content: string; score: number }>;
    imports: string[];
    symbols: string[];
  }> {
    const { projectName, currentFile, currentCode, language, limit = 5 } = options;
    const collection = this.getCodebaseCollection(projectName);

    const result = {
      patterns: [] as Array<{ file: string; content: string; score: number }>,
      imports: [] as string[],
      symbols: [] as string[],
    };

    try {
      const embedding = await embeddingService.embed(currentCode);

      // Search codebase, excluding current file
      const filter: Record<string, unknown> = {
        must_not: [{ key: 'file', match: { value: currentFile } }],
      };
      if (language) {
        filter.must = [{ key: 'language', match: { value: language } }];
      }

      const results = await vectorStore.search(collection, embedding, limit * 3, filter, 0.5);

      // Deduplicate by file
      const seenFiles = new Set<string>();
      for (const r of results) {
        const file = r.payload.file as string;
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);

        result.patterns.push({
          file,
          content: r.payload.content as string,
          score: r.score,
        });

        // Extract imports from results
        const fileImports = this.extractImports(r.payload.content as string);
        for (const imp of fileImports) {
          if (!result.imports.includes(imp)) {
            result.imports.push(imp);
          }
        }

        // Extract exported symbols
        const symbols = this.extractSymbols(r.payload.content as string);
        for (const sym of symbols) {
          if (!result.symbols.includes(sym)) {
            result.symbols.push(sym);
          }
        }

        if (result.patterns.length >= limit) break;
      }

      return result;
    } catch (error: any) {
      logger.error('Failed to get completion context', { error: error.message });
      return result;
    }
  }

  /**
   * Suggest missing imports based on similar files
   */
  async getImportSuggestions(options: {
    projectName: string;
    currentFile: string;
    currentCode: string;
    language?: string;
    limit?: number;
  }): Promise<{
    suggestions: Array<{ importPath: string; frequency: number; usedBy: string[] }>;
    currentImports: string[];
  }> {
    const { projectName, currentFile, currentCode, language, limit = 10 } = options;
    const collection = this.getCodebaseCollection(projectName);

    const currentImports = this.extractImports(currentCode);

    const result = {
      suggestions: [] as Array<{ importPath: string; frequency: number; usedBy: string[] }>,
      currentImports,
    };

    try {
      const embedding = await embeddingService.embed(currentCode);

      const filter: Record<string, unknown> = {
        must_not: [{ key: 'file', match: { value: currentFile } }],
      };
      if (language) {
        filter.must = [{ key: 'language', match: { value: language } }];
      }

      const results = await vectorStore.search(collection, embedding, 20, filter, 0.5);

      // Aggregate imports from similar files
      const importFreq = new Map<string, { count: number; files: string[] }>();

      for (const r of results) {
        const file = r.payload.file as string;
        const fileImports = this.extractImports(r.payload.content as string);

        for (const imp of fileImports) {
          // Skip imports already present
          if (currentImports.includes(imp)) continue;

          const existing = importFreq.get(imp) || { count: 0, files: [] };
          existing.count++;
          if (!existing.files.includes(file)) {
            existing.files.push(file);
          }
          importFreq.set(imp, existing);
        }
      }

      // Rank by frequency
      result.suggestions = Array.from(importFreq.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([importPath, data]) => ({
          importPath,
          frequency: data.count,
          usedBy: data.files.slice(0, 3),
        }));

      return result;
    } catch (error: any) {
      logger.error('Failed to get import suggestions', { error: error.message });
      return result;
    }
  }

  /**
   * Look up type/interface/class definitions and their usage
   */
  async getTypeContext(options: {
    projectName: string;
    typeName?: string;
    code?: string;
    currentFile?: string;
    limit?: number;
  }): Promise<{
    definitions: Array<{ file: string; content: string; score: number; typeName: string }>;
    usages: Array<{ file: string; content: string; score: number }>;
  }> {
    const { projectName, typeName, code, currentFile, limit = 5 } = options;
    const collection = this.getCodebaseCollection(projectName);

    const result = {
      definitions: [] as Array<{ file: string; content: string; score: number; typeName: string }>,
      usages: [] as Array<{ file: string; content: string; score: number }>,
    };

    if (!typeName && !code) {
      return result;
    }

    try {
      // Build a search query targeting type definitions
      const searchQuery = typeName
        ? `interface ${typeName} type ${typeName} class ${typeName}`
        : code!;

      const embedding = await embeddingService.embed(searchQuery);

      let filter: Record<string, unknown> | undefined;
      if (currentFile) {
        filter = { must_not: [{ key: 'file', match: { value: currentFile } }] };
      }

      const results = await vectorStore.search(collection, embedding, limit * 4, filter, 0.4);

      const typePattern = typeName
        ? new RegExp(
            `(?:interface|type|class|enum)\\s+${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
          )
        : null;

      const seenDefs = new Set<string>();
      const seenUsages = new Set<string>();

      for (const r of results) {
        const file = r.payload.file as string;
        const content = r.payload.content as string;

        // Check if this contains a type definition
        if (typePattern && typePattern.test(content)) {
          if (!seenDefs.has(file)) {
            seenDefs.add(file);
            result.definitions.push({
              file,
              content,
              score: r.score,
              typeName: typeName!,
            });
          }
        } else {
          // It's a usage
          if (!seenUsages.has(file) && result.usages.length < limit) {
            seenUsages.add(file);
            result.usages.push({ file, content, score: r.score });
          }
        }

        if (result.definitions.length >= limit && result.usages.length >= limit) break;
      }

      return result;
    } catch (error: any) {
      logger.error('Failed to get type context', { error: error.message });
      return result;
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private generateReason(result: SearchResult, code?: string, description?: string): string {
    const file = result.payload.file as string;
    const language = result.payload.language as string;

    if (code) {
      return `Similar ${language || 'code'} structure in ${file}`;
    }
    return `Matches description in ${file}`;
  }

  private generateImplementationReason(patternType: string, file: string): string {
    const reasons: Record<string, string> = {
      similar_structure: `Similar code structure found in ${file}`,
      same_domain: `Related domain implementation in ${file}`,
      related_import: `Uses similar dependencies in ${file}`,
      test_pattern: `Test pattern reference in ${file}`,
    };
    return reasons[patternType] || `Reference implementation in ${file}`;
  }

  private classifyPattern(
    targetCode: string,
    foundContent: string,
    file: string
  ): 'similar_structure' | 'same_domain' | 'related_import' | 'test_pattern' {
    // Check if it's a test file
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__')) {
      return 'test_pattern';
    }

    // Check for import similarity
    const targetImports = this.extractImports(targetCode);
    const foundImports = this.extractImports(foundContent);
    const commonImports = targetImports.filter((i) =>
      foundImports.some((f) => f.includes(i) || i.includes(f))
    );
    if (commonImports.length > 2) {
      return 'related_import';
    }

    // Check for structural similarity (function/class patterns)
    const hasClassPattern = /class\s+\w+/.test(targetCode) && /class\s+\w+/.test(foundContent);
    const hasFunctionPattern =
      /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(/.test(targetCode) &&
      /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(/.test(foundContent);
    if (hasClassPattern || hasFunctionPattern) {
      return 'similar_structure';
    }

    return 'same_domain';
  }

  private generateAdaptationHints(targetCode: string, foundContent: string): string[] {
    const hints: string[] = [];

    // Check for async patterns
    if (foundContent.includes('async') && !targetCode.includes('async')) {
      hints.push('Consider using async/await pattern');
    }

    // Check for error handling
    if (
      foundContent.includes('try') &&
      foundContent.includes('catch') &&
      !targetCode.includes('try')
    ) {
      hints.push('Add error handling with try/catch');
    }

    // Check for TypeScript types
    if (foundContent.includes(': ') && !targetCode.includes(': ')) {
      hints.push('Add TypeScript type annotations');
    }

    return hints;
  }

  private detectTestType(file: string, content: string): 'unit' | 'integration' | 'e2e' {
    if (file.includes('e2e') || file.includes('cypress') || file.includes('playwright')) {
      return 'e2e';
    }
    if (
      content.includes('supertest') ||
      content.includes('request(app)') ||
      file.includes('integration')
    ) {
      return 'integration';
    }
    return 'unit';
  }

  private detectTestFramework(content: string): string | undefined {
    if (content.includes('describe(') && content.includes('it(')) {
      if (content.includes('vitest')) return 'vitest';
      if (content.includes('jest')) return 'jest';
      return 'jest/mocha';
    }
    if (content.includes('pytest') || content.includes('def test_')) return 'pytest';
    if (content.includes('testing.T')) return 'go-testing';
    return undefined;
  }

  private extractTestCoverage(content: string): string[] {
    const coverage: string[] = [];

    // Extract test descriptions from describe/it blocks
    const describeMatches = content.match(/describe\(['"`]([^'"`]+)['"`]/g) || [];
    const itMatches = content.match(/it\(['"`]([^'"`]+)['"`]/g) || [];

    for (const match of describeMatches) {
      const desc = match.replace(/describe\(['"`]/, '').replace(/['"`]$/, '');
      coverage.push(`describes: ${desc}`);
    }

    for (const match of itMatches.slice(0, 5)) {
      const desc = match.replace(/it\(['"`]/, '').replace(/['"`]$/, '');
      coverage.push(`tests: ${desc}`);
    }

    return coverage;
  }

  private extractSymbols(code: string): string[] {
    const symbols: string[] = [];

    // Exported functions/constants
    const exportMatches =
      code.match(/export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g) || [];
    for (const match of exportMatches) {
      const m = match.match(/(?:const|function|class|interface|type|enum)\s+(\w+)/);
      if (m) symbols.push(m[1]);
    }

    return [...new Set(symbols)];
  }

  private extractImports(code: string): string[] {
    const imports: string[] = [];

    // ES6 imports
    const es6Imports = code.match(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g) || [];
    for (const imp of es6Imports) {
      const match = imp.match(/from\s+['"]([^'"]+)['"]/);
      if (match) imports.push(match[1]);
    }

    // CommonJS requires
    const cjsImports = code.match(/require\(['"]([^'"]+)['"]\)/g) || [];
    for (const imp of cjsImports) {
      const match = imp.match(/require\(['"]([^'"]+)['"]\)/);
      if (match) imports.push(match[1]);
    }

    // Python imports
    const pyImports = code.match(/(?:from\s+(\S+)\s+import|import\s+(\S+))/g) || [];
    for (const imp of pyImports) {
      const match = imp.match(/(?:from\s+(\S+)|import\s+(\S+))/);
      if (match) imports.push(match[1] || match[2]);
    }

    return [...new Set(imports)];
  }
}

export const codeSuggestions = new CodeSuggestionService();
export default codeSuggestions;
