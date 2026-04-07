/**
 * Code Parser - AST-based (ts-morph) for TS/JS, regex fallback for other languages.
 */

import * as path from 'path';
import { Project } from 'ts-morph';
import type { FileParser, ParsedChunk } from './base-parser';
import config from '../../config';

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.kt',
  '.scala',
  '.sh',
  '.bash',
]);

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// Patterns for function/class boundaries (non-TS/JS fallback)
const BOUNDARY_PATTERNS = [
  // TypeScript/JavaScript
  /^(?:export\s+)?(?:async\s+)?function\s+\w+/,
  /^(?:export\s+)?(?:default\s+)?class\s+\w+/,
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/,
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\()/,
  /^(?:export\s+)?interface\s+\w+/,
  /^(?:export\s+)?type\s+\w+\s*=/,
  /^(?:export\s+)?enum\s+\w+/,
  // Python
  /^(?:async\s+)?def\s+\w+/,
  /^class\s+\w+/,
  // Go
  /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+/,
  /^type\s+\w+\s+struct/,
  // Rust
  /^(?:pub\s+)?(?:async\s+)?fn\s+\w+/,
  /^(?:pub\s+)?struct\s+\w+/,
  /^(?:pub\s+)?enum\s+\w+/,
  /^impl\s+/,
  // Java/C#
  /^(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|enum)\s+\w+/,
  /^(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?\w+\s+\w+\s*\(/,
];

// Symbol extraction patterns
const SYMBOL_PATTERNS = [
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /(?:export\s+)?(?:default\s+)?class\s+(\w+)/g,
  /(?:export\s+)?interface\s+(\w+)/g,
  /(?:export\s+)?type\s+(\w+)\s*=/g,
  /(?:export\s+)?enum\s+(\w+)/g,
  /(?:async\s+)?def\s+(\w+)/g,
  /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
  /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
  /(?:pub\s+)?struct\s+(\w+)/g,
  /(?:pub\s+)?enum\s+(\w+)/g,
];

// Import extraction patterns
const IMPORT_PATTERNS = [
  /import\s+.*?from\s+['"]([^'"]+)['"]/g,
  /import\s+['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /from\s+(\S+)\s+import/g, // Python
];

function getLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.vue': 'vue',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.sh': 'shell',
    '.bash': 'shell',
  };
  return langMap[ext] || 'unknown';
}

export class CodeParser implements FileParser {
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return CODE_EXTENSIONS.has(ext);
  }

  parse(content: string, filePath: string): ParsedChunk[] {
    const ext = path.extname(filePath).toLowerCase();

    // Use ts-morph AST for TypeScript/JavaScript files
    if (TS_JS_EXTENSIONS.has(ext)) {
      try {
        const chunks = this.parseTypeScript(content, filePath);
        if (chunks.length > 0) return chunks;
      } catch {
        // Fall through to regex parser on AST failure
      }
    }

    // Regex-based fallback for other languages or AST failure
    return this.parseWithRegex(content, filePath);
  }

  /**
   * AST-based parsing for TypeScript/JavaScript using ts-morph.
   * Extracts classes, functions, interfaces, type aliases, and enums as separate chunks.
   */
  private parseTypeScript(content: string, filePath: string): ParsedChunk[] {
    const language = getLanguage(filePath);
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true },
    });
    const ext = path.extname(filePath).toLowerCase();
    const tempName = ext === '.jsx' ? 'temp.tsx' : `temp${ext}`;
    const sourceFile = project.createSourceFile(tempName, content);

    const chunks: ParsedChunk[] = [];

    // Extract file-level imports
    const imports = sourceFile.getImportDeclarations().map((i) => i.getModuleSpecifierValue());

    // Extract classes — split large classes into per-method chunks
    for (const cls of sourceFile.getClasses()) {
      const name = cls.getName() || 'anonymous';
      const classText = cls.getFullText();
      const methods = cls.getMethods();
      const methodNames = methods.map((m) => m.getName());
      const jsdoc = cls
        .getJsDocs()
        .map((d) => d.getDescription())
        .filter(Boolean)
        .join('\n');

      if (classText.length > 3000 && methods.length > 1) {
        // Large class: emit summary chunk + per-method chunks
        const summaryContent = this.buildClassSummary(cls);
        chunks.push({
          content: summaryContent,
          startLine: cls.getStartLineNumber(),
          endLine: cls.getEndLineNumber(),
          language,
          type: 'code',
          symbols: [name, ...methodNames],
          imports: chunks.length === 0 ? imports : undefined,
          metadata: {
            kind: 'class-summary',
            extends: cls.getExtends()?.getText(),
            implements: cls.getImplements().map((i) => i.getText()),
            exported: cls.isExported(),
            ...(jsdoc ? { jsdoc } : {}),
          },
        });

        // Per-method chunks
        for (const method of methods) {
          const methodJsdoc = method
            .getJsDocs()
            .map((d) => d.getDescription())
            .filter(Boolean)
            .join('\n');
          chunks.push({
            content: method.getFullText(),
            startLine: method.getStartLineNumber(),
            endLine: method.getEndLineNumber(),
            language,
            type: 'code',
            symbols: [`${name}.${method.getName()}`],
            imports: undefined,
            metadata: {
              kind: 'method',
              className: name,
              exported: cls.isExported(),
              ...(methodJsdoc ? { jsdoc: methodJsdoc } : {}),
            },
          });
        }
      } else {
        // Small class: emit as single chunk (existing behavior)
        chunks.push({
          content: classText,
          startLine: cls.getStartLineNumber(),
          endLine: cls.getEndLineNumber(),
          language,
          type: 'code',
          symbols: [name, ...methodNames],
          imports: chunks.length === 0 ? imports : undefined,
          metadata: {
            kind: 'class',
            extends: cls.getExtends()?.getText(),
            implements: cls.getImplements().map((i) => i.getText()),
            exported: cls.isExported(),
            ...(jsdoc ? { jsdoc } : {}),
          },
        });
      }
    }

    // Extract standalone functions
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName() || 'anonymous';
      const jsdoc = fn
        .getJsDocs()
        .map((d) => d.getDescription())
        .filter(Boolean)
        .join('\n');

      chunks.push({
        content: fn.getFullText(),
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        language,
        type: 'code',
        symbols: [name],
        imports: chunks.length === 0 ? imports : undefined,
        metadata: {
          kind: 'function',
          exported: fn.isExported(),
          ...(jsdoc ? { jsdoc } : {}),
        },
      });
    }

    // Extract interfaces
    for (const iface of sourceFile.getInterfaces()) {
      chunks.push({
        content: iface.getFullText(),
        startLine: iface.getStartLineNumber(),
        endLine: iface.getEndLineNumber(),
        language,
        type: 'code',
        symbols: [iface.getName()],
        imports: chunks.length === 0 ? imports : undefined,
        metadata: { kind: 'interface', exported: iface.isExported() },
      });
    }

    // Extract type aliases
    for (const ta of sourceFile.getTypeAliases()) {
      chunks.push({
        content: ta.getFullText(),
        startLine: ta.getStartLineNumber(),
        endLine: ta.getEndLineNumber(),
        language,
        type: 'code',
        symbols: [ta.getName()],
        imports: chunks.length === 0 ? imports : undefined,
        metadata: { kind: 'type', exported: ta.isExported() },
      });
    }

    // Extract enums
    for (const en of sourceFile.getEnums()) {
      chunks.push({
        content: en.getFullText(),
        startLine: en.getStartLineNumber(),
        endLine: en.getEndLineNumber(),
        language,
        type: 'code',
        symbols: [en.getName()],
        imports: chunks.length === 0 ? imports : undefined,
        metadata: { kind: 'enum', exported: en.isExported() },
      });
    }

    // Extract top-level variable declarations (arrow functions, consts)
    for (const vs of sourceFile.getVariableStatements()) {
      for (const decl of vs.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init) continue;
        const text = init.getText();
        // Only create separate chunks for arrow functions or significant declarations
        if (text.includes('=>') || text.includes('function') || text.length > 100) {
          const name = decl.getName();
          // Skip if already captured by a class/function chunk
          if (chunks.some((c) => c.symbols?.includes(name))) continue;

          chunks.push({
            content: vs.getFullText(),
            startLine: vs.getStartLineNumber(),
            endLine: vs.getEndLineNumber(),
            language,
            type: 'code',
            symbols: [name],
            imports: chunks.length === 0 ? imports : undefined,
            metadata: { kind: 'variable', exported: vs.isExported() },
          });
        }
      }
    }

    // If first chunk doesn't have imports, add them
    if (chunks.length > 0 && !chunks[0].imports) {
      chunks[0].imports = imports;
    }

    return chunks;
  }

  /**
   * Regex-based parsing (fallback for non-TS/JS or AST failures).
   */
  private parseWithRegex(content: string, filePath: string): ParsedChunk[] {
    const language = getLanguage(filePath);
    const lines = content.split('\n');

    const allSymbols = this.extractSymbols(content);
    const allImports = this.extractImports(content);

    const boundaries = this.findBoundaries(lines);

    if (boundaries.length >= 2) {
      return this.chunkByBoundaries(lines, boundaries, language, allSymbols, allImports);
    }

    return this.chunkByLines(lines, language, allSymbols, allImports);
  }

  private findBoundaries(lines: string[]): number[] {
    const boundaries: number[] = [0];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (BOUNDARY_PATTERNS.some((p) => p.test(trimmed))) {
        const last = boundaries[boundaries.length - 1];
        if (i - last >= 5) {
          boundaries.push(i);
        }
      }
    }

    return boundaries;
  }

  private chunkByBoundaries(
    lines: string[],
    boundaries: number[],
    language: string,
    allSymbols: string[],
    allImports: string[]
  ): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];

    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
      const chunkLines = lines.slice(start, end);
      const chunkContent = chunkLines.join('\n');

      if (chunkContent.trim().length < 10) continue;

      const chunkSymbols = this.extractSymbols(chunkContent);

      chunks.push({
        content: chunkContent,
        startLine: start + 1,
        endLine: end,
        language,
        type: 'code',
        symbols: chunkSymbols.length > 0 ? chunkSymbols : undefined,
        imports: i === 0 ? allImports : undefined,
      });
    }

    return chunks;
  }

  private chunkByLines(
    lines: string[],
    language: string,
    allSymbols: string[],
    allImports: string[]
  ): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const maxChunkSize = config.CHUNK_SIZE;
    let currentStart = 0;
    let currentSize = 0;
    let chunkLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (currentSize + line.length > maxChunkSize && chunkLines.length > 0) {
        const chunkContent = chunkLines.join('\n');
        const chunkSymbols = this.extractSymbols(chunkContent);

        chunks.push({
          content: chunkContent,
          startLine: currentStart + 1,
          endLine: i,
          language,
          type: 'code',
          symbols: chunkSymbols.length > 0 ? chunkSymbols : undefined,
          imports: chunks.length === 0 ? allImports : undefined,
        });

        chunkLines = [];
        currentStart = i;
        currentSize = 0;
      }
      chunkLines.push(line);
      currentSize += line.length + 1;
    }

    if (chunkLines.length > 0) {
      const chunkContent = chunkLines.join('\n');
      const chunkSymbols = this.extractSymbols(chunkContent);

      chunks.push({
        content: chunkContent,
        startLine: currentStart + 1,
        endLine: lines.length,
        language,
        type: 'code',
        symbols: chunkSymbols.length > 0 ? chunkSymbols : undefined,
        imports: chunks.length === 0 ? allImports : undefined,
      });
    }

    return chunks;
  }

  extractSymbols(content: string): string[] {
    const symbols = new Set<string>();

    for (const pattern of SYMBOL_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (match[1] && match[1].length > 1) {
          symbols.add(match[1]);
        }
      }
    }

    return [...symbols];
  }

  /**
   * Build a class summary: declaration line, properties, and method signatures (no bodies).
   */
  private buildClassSummary(cls: import('ts-morph').ClassDeclaration): string {
    const lines: string[] = [];

    // Class declaration line
    const name = cls.getName() || 'anonymous';
    const extendsClause = cls.getExtends()?.getText();
    const implementsClauses = cls.getImplements().map((i) => i.getText());
    let decl = cls.isExported() ? 'export ' : '';
    decl += `class ${name}`;
    if (extendsClause) decl += ` extends ${extendsClause}`;
    if (implementsClauses.length > 0) decl += ` implements ${implementsClauses.join(', ')}`;
    decl += ' {';
    lines.push(decl);

    // Properties
    for (const prop of cls.getProperties()) {
      lines.push('  ' + prop.getText().replace(/\s*=\s*[\s\S]*$/, '') + ';');
    }

    if (cls.getProperties().length > 0) lines.push('');

    // Method signatures (no bodies)
    for (const method of cls.getMethods()) {
      const modifiers = method
        .getModifiers()
        .map((m) => m.getText())
        .join(' ');
      const params = method
        .getParameters()
        .map((p) => p.getText())
        .join(', ');
      const returnType = method.getReturnTypeNode()?.getText();
      const async = method.isAsync() ? 'async ' : '';
      let sig = '  ';
      if (modifiers) sig += modifiers + ' ';
      sig += `${async}${method.getName()}(${params})`;
      if (returnType) sig += `: ${returnType}`;
      sig += ';';
      lines.push(sig);
    }

    lines.push('}');
    return lines.join('\n');
  }

  extractImports(content: string): string[] {
    const imports = new Set<string>();

    for (const pattern of IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (match[1]) {
          imports.add(match[1]);
        }
      }
    }

    return [...imports];
  }
}

export const codeParser = new CodeParser();
