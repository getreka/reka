/**
 * Contract Parser - Handles OpenAPI, Proto, GraphQL schemas.
 */

import * as path from 'path';
import type { FileParser, ParsedChunk } from './base-parser';

const CONTRACT_EXTENSIONS = new Set(['.proto', '.graphql', '.gql']);

export class ContractParser implements FileParser {
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    if (CONTRACT_EXTENSIONS.has(ext)) return true;
    // OpenAPI/Swagger files
    if (basename.includes('openapi') || basename.includes('swagger')) return true;

    return false;
  }

  parse(content: string, filePath: string): ParsedChunk[] {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    if (ext === '.proto') return this.parseProto(content);
    if (ext === '.graphql' || ext === '.gql') return this.parseGraphQL(content);
    if (basename.includes('openapi') || basename.includes('swagger')) {
      return this.parseOpenAPI(content, ext);
    }

    return [
      {
        content,
        startLine: 1,
        endLine: content.split('\n').length,
        language: 'contract',
        type: 'contract',
      },
    ];
  }

  private parseProto(content: string): ParsedChunk[] {
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    const blockPattern = /^(message|service|enum|rpc)\s+(\w+)/;
    let currentStart = 0;
    let currentLines: string[] = [];
    let currentSymbol = '';

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(blockPattern);
      if (match) {
        if (currentLines.length > 0 && currentSymbol) {
          chunks.push({
            content: currentLines.join('\n'),
            startLine: currentStart + 1,
            endLine: i,
            language: 'protobuf',
            type: 'contract',
            symbols: [currentSymbol],
          });
        }
        currentSymbol = match[2];
        currentStart = i;
        currentLines = [lines[i]];
      } else {
        currentLines.push(lines[i]);
      }
    }

    if (currentLines.length > 0 && currentSymbol) {
      chunks.push({
        content: currentLines.join('\n'),
        startLine: currentStart + 1,
        endLine: lines.length,
        language: 'protobuf',
        type: 'contract',
        symbols: [currentSymbol],
      });
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            content,
            startLine: 1,
            endLine: lines.length,
            language: 'protobuf',
            type: 'contract',
          },
        ];
  }

  private parseGraphQL(content: string): ParsedChunk[] {
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    const blockPattern =
      /^(type|input|enum|interface|union|scalar|query|mutation|subscription)\s+(\w+)/i;
    let currentStart = 0;
    let currentLines: string[] = [];
    let currentSymbol = '';

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(blockPattern);
      if (match) {
        if (currentLines.length > 0 && currentSymbol) {
          chunks.push({
            content: currentLines.join('\n'),
            startLine: currentStart + 1,
            endLine: i,
            language: 'graphql',
            type: 'contract',
            symbols: [currentSymbol],
          });
        }
        currentSymbol = match[2];
        currentStart = i;
        currentLines = [lines[i]];
      } else {
        currentLines.push(lines[i]);
      }
    }

    if (currentLines.length > 0 && currentSymbol) {
      chunks.push({
        content: currentLines.join('\n'),
        startLine: currentStart + 1,
        endLine: lines.length,
        language: 'graphql',
        type: 'contract',
        symbols: [currentSymbol],
      });
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            content,
            startLine: 1,
            endLine: lines.length,
            language: 'graphql',
            type: 'contract',
          },
        ];
  }

  private parseOpenAPI(content: string, ext: string): ParsedChunk[] {
    // Treat as config (YAML/JSON) with 'contract' type
    const language = ext === '.json' ? 'json' : 'yaml';
    const lines = content.split('\n');

    // Try to split by top-level paths
    const chunks: ParsedChunk[] = [];
    let currentStart = 0;
    let currentLines: string[] = [];
    let currentSymbol = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // YAML top-level key (no indent) or JSON top-level
      if (/^[a-zA-Z\/]/.test(line) && line.includes(':')) {
        if (currentLines.length > 0 && currentSymbol) {
          chunks.push({
            content: currentLines.join('\n'),
            startLine: currentStart + 1,
            endLine: i,
            language,
            type: 'contract',
            symbols: [currentSymbol],
          });
        }
        currentSymbol = line.split(':')[0].trim();
        currentStart = i;
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0 && currentSymbol) {
      chunks.push({
        content: currentLines.join('\n'),
        startLine: currentStart + 1,
        endLine: lines.length,
        language,
        type: 'contract',
        symbols: [currentSymbol],
      });
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            content,
            startLine: 1,
            endLine: lines.length,
            language,
            type: 'contract',
          },
        ];
  }
}

export const contractParser = new ContractParser();
