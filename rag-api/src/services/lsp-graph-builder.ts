import * as path from 'path';
import { lspClient } from './lsp-client';
import { logger } from '../utils/logger';
import config from '../config';
import type { GraphEdge } from './parsers/ast-parser';
import pLimitModule from 'p-limit';
const pLimit = (pLimitModule as any).default || pLimitModule;

class LSPGraphBuilder {
  /**
   * Build call graph edges for a file using LSP outgoingCalls.
   */
  async buildCallEdgesForFile(filePath: string, projectPath: string): Promise<GraphEdge[]> {
    if (!config.LSP_ENABLED) return [];

    const symbols = await lspClient.documentSymbol(filePath, projectPath);
    if (!symbols || symbols.length === 0) return [];

    const edges: GraphEdge[] = [];
    const limit = pLimit(config.LSP_MAX_CONCURRENT);
    const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');

    // Only query call hierarchy for functions/methods (kinds 6, 12)
    const callableSymbols = symbols.filter((s) => [6, 12].includes(s.kind));

    await Promise.all(
      callableSymbols.slice(0, 50).map((sym) =>
        limit(async () => {
          try {
            const outgoing = await lspClient.outgoingCalls(filePath, sym.startLine, 0, projectPath);
            if (!outgoing) return;

            for (const call of outgoing) {
              const toFile = path.relative(projectPath, call.file).replace(/\\/g, '/');
              edges.push({
                fromFile: relativePath,
                fromSymbol: sym.name,
                toFile,
                toSymbol: call.name,
                edgeType: 'calls',
                confidence: 'lsp',
              });
            }
          } catch (err: any) {
            logger.debug('LSP outgoingCalls failed for symbol', {
              symbol: sym.name,
              file: relativePath,
              error: err.message,
            });
          }
        })
      )
    );

    return edges;
  }

  /**
   * Build import resolution edges using LSP goToDefinition.
   * Takes existing tree-sitter import edges and resolves toFile via LSP.
   */
  async buildImportEdgesForFile(
    filePath: string,
    projectPath: string,
    treeSitterEdges: GraphEdge[]
  ): Promise<GraphEdge[]> {
    if (!config.LSP_ENABLED) return [];

    const importEdges = treeSitterEdges.filter((e) => e.edgeType === 'imports');
    if (importEdges.length === 0) return [];

    const edges: GraphEdge[] = [];
    const limit = pLimit(config.LSP_MAX_CONCURRENT);
    const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');

    // Find import positions using documentSymbol or file scan
    const symbols = await lspClient.documentSymbol(filePath, projectPath);

    await Promise.all(
      importEdges.slice(0, 100).map((edge) =>
        limit(async () => {
          try {
            // Find the symbol position in the file
            const sym = symbols?.find((s) => s.name === edge.fromSymbol);
            const line = sym?.startLine ?? 0;
            const char = 0;

            const definitions = await lspClient.goToDefinition(filePath, line, char, projectPath);
            if (!definitions || definitions.length === 0) return;

            const def = definitions[0];
            const toFile = path.relative(projectPath, def.file).replace(/\\/g, '/');

            edges.push({
              fromFile: relativePath,
              fromSymbol: edge.fromSymbol,
              toFile,
              toSymbol: edge.toSymbol,
              edgeType: 'imports',
              confidence: 'lsp',
            });
          } catch (err: any) {
            logger.debug('LSP goToDefinition failed', {
              symbol: edge.fromSymbol,
              error: err.message,
            });
          }
        })
      )
    );

    return edges;
  }

  /**
   * Build all edge types for a file (calls + resolved imports).
   */
  async buildAllEdgesForFile(
    filePath: string,
    projectPath: string,
    treeSitterEdges?: GraphEdge[]
  ): Promise<GraphEdge[]> {
    const [callEdges, importEdges] = await Promise.all([
      this.buildCallEdgesForFile(filePath, projectPath),
      treeSitterEdges
        ? this.buildImportEdgesForFile(filePath, projectPath, treeSitterEdges)
        : Promise.resolve([]),
    ]);

    return [...callEdges, ...importEdges];
  }

  /**
   * Check if LSP is available for a file's language.
   */
  isAvailable(filePath: string): boolean {
    if (!config.LSP_ENABLED) return false;
    const ext = path.extname(filePath);
    return lspClient.isAvailable(ext);
  }
}

export const lspGraphBuilder = new LSPGraphBuilder();
