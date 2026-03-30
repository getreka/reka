/**
 * AST Parser - Regex-based code parser with graph edge extraction.
 * Falls back to regex since tree-sitter native build may not be available.
 */

import * as path from 'path';
import type { FileParser, ParsedChunk } from './base-parser';
import { CodeParser } from './code-parser';

export interface GraphEdge {
  fromFile: string;
  fromSymbol: string;
  toFile: string;
  toSymbol: string;
  edgeType: 'imports' | 'calls' | 'extends' | 'implements' | 'depends_on';
  confidence?: 'lsp' | 'scip' | 'tree-sitter' | 'heuristic';
  symbolDescriptor?: string;
}

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java']);

export class ASTParser implements FileParser {
  private codeParser = new CodeParser();

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  parse(content: string, filePath: string): ParsedChunk[] {
    // Delegate to CodeParser for chunks — AST parser adds edge extraction
    return this.codeParser.parse(content, filePath);
  }

  /**
   * Extract import/call/extends edges from source code.
   */
  extractEdges(content: string, filePath: string): GraphEdge[] {
    const ext = path.extname(filePath).toLowerCase();
    const edges: GraphEdge[] = [];

    // Extract imports
    edges.push(...this.extractImportEdges(content, filePath, ext));
    // Extract extends/implements
    edges.push(...this.extractInheritanceEdges(content, filePath, ext));

    // Stamp all regex-derived edges as heuristic confidence
    for (const edge of edges) {
      if (!edge.confidence) edge.confidence = 'heuristic';
    }

    return edges;
  }

  private extractImportEdges(content: string, filePath: string, ext: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const fromFile = filePath;

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // ES imports: import { X } from './path'
      const esImports = [
        ...content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g),
      ];
      for (const m of esImports) {
        const symbols = m[1]
          ? m[1].split(',').map((s) =>
              s
                .trim()
                .split(/\s+as\s+/)[0]
                .trim()
            )
          : [m[2]];
        const toFile = this.resolveImportPath(m[3], filePath, ext);

        for (const sym of symbols) {
          if (sym) {
            edges.push({
              fromFile,
              fromSymbol: sym,
              toFile,
              toSymbol: sym,
              edgeType: 'imports',
            });
          }
        }
      }

      // require() calls
      const requires = [
        ...content.matchAll(
          /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
        ),
      ];
      for (const m of requires) {
        const symbols = m[1] ? m[1].split(',').map((s) => s.trim()) : [m[2]];
        const toFile = this.resolveImportPath(m[3], filePath, ext);

        for (const sym of symbols) {
          if (sym) {
            edges.push({
              fromFile,
              fromSymbol: sym,
              toFile,
              toSymbol: sym,
              edgeType: 'imports',
            });
          }
        }
      }
    } else if (ext === '.py') {
      // Python: from X import Y
      const pyImports = [...content.matchAll(/from\s+([\w.]+)\s+import\s+(.+)/g)];
      for (const m of pyImports) {
        const module = m[1].replace(/\./g, '/');
        const symbols = m[2].split(',').map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim()
        );
        for (const sym of symbols) {
          if (sym) {
            edges.push({
              fromFile,
              fromSymbol: sym,
              toFile: `${module}.py`,
              toSymbol: sym,
              edgeType: 'imports',
            });
          }
        }
      }

      // Python: import X
      const pyDirectImports = [...content.matchAll(/^import\s+([\w.]+)/gm)];
      for (const m of pyDirectImports) {
        const module = m[1].replace(/\./g, '/');
        edges.push({
          fromFile,
          fromSymbol: m[1],
          toFile: `${module}.py`,
          toSymbol: m[1],
          edgeType: 'imports',
        });
      }
    } else if (ext === '.go') {
      // Go imports
      const goImports = [...content.matchAll(/import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g)];
      for (const m of goImports) {
        const block = m[1] || m[2];
        const paths = [...block.matchAll(/"([^"]+)"/g)];
        for (const p of paths) {
          const pkg = p[1];
          edges.push({
            fromFile,
            fromSymbol: path.basename(pkg),
            toFile: pkg,
            toSymbol: path.basename(pkg),
            edgeType: 'imports',
          });
        }
      }
    }

    return edges;
  }

  private extractInheritanceEdges(content: string, filePath: string, ext: string): GraphEdge[] {
    const edges: GraphEdge[] = [];

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // class X extends Y
      const extendsMatches = [...content.matchAll(/class\s+(\w+)\s+extends\s+(\w+)/g)];
      for (const m of extendsMatches) {
        edges.push({
          fromFile: filePath,
          fromSymbol: m[1],
          toFile: filePath, // same file or unknown
          toSymbol: m[2],
          edgeType: 'extends',
        });
      }

      // class X implements Y
      const implMatches = [
        ...content.matchAll(/class\s+(\w+)(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+)/g),
      ];
      for (const m of implMatches) {
        const interfaces = m[2].split(',').map((s) => s.trim());
        for (const iface of interfaces) {
          if (iface) {
            edges.push({
              fromFile: filePath,
              fromSymbol: m[1],
              toFile: filePath,
              toSymbol: iface,
              edgeType: 'implements',
            });
          }
        }
      }
    } else if (ext === '.py') {
      // class X(Y, Z)
      const pyClasses = [...content.matchAll(/class\s+(\w+)\s*\(([^)]+)\)/g)];
      for (const m of pyClasses) {
        const bases = m[2].split(',').map((s) => s.trim());
        for (const base of bases) {
          if (base && base !== 'object') {
            edges.push({
              fromFile: filePath,
              fromSymbol: m[1],
              toFile: filePath,
              toSymbol: base,
              edgeType: 'extends',
            });
          }
        }
      }
    } else if (ext === '.java') {
      const javaExtends = [...content.matchAll(/class\s+(\w+)\s+extends\s+(\w+)/g)];
      for (const m of javaExtends) {
        edges.push({
          fromFile: filePath,
          fromSymbol: m[1],
          toFile: filePath,
          toSymbol: m[2],
          edgeType: 'extends',
        });
      }

      const javaImpl = [
        ...content.matchAll(/class\s+(\w+)(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+)/g),
      ];
      for (const m of javaImpl) {
        const interfaces = m[2].split(',').map((s) => s.trim());
        for (const iface of interfaces) {
          if (iface) {
            edges.push({
              fromFile: filePath,
              fromSymbol: m[1],
              toFile: filePath,
              toSymbol: iface,
              edgeType: 'implements',
            });
          }
        }
      }
    }

    return edges;
  }

  /**
   * Resolve relative import paths to normalized paths.
   */
  private resolveImportPath(importPath: string, fromFile: string, ext: string): string {
    if (!importPath.startsWith('.')) {
      // External package
      return importPath;
    }

    const dir = path.dirname(fromFile);
    let resolved = path.join(dir, importPath);

    // Add extension if not present
    if (!path.extname(resolved)) {
      resolved += ext;
    }

    return resolved.replace(/\\/g, '/');
  }
}

export const astParser = new ASTParser();
