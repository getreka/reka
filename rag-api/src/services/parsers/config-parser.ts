/**
 * Config Parser - Splits YAML/JSON/TOML/env files by top-level keys.
 */

import * as path from 'path';
import type { FileParser, ParsedChunk } from './base-parser';

const CONFIG_EXTENSIONS = new Set([
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.env',
  '.hcl',
  '.ini',
  '.cfg',
  '.conf',
]);

export class ConfigParser implements FileParser {
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return CONFIG_EXTENSIONS.has(ext);
  }

  parse(content: string, filePath: string): ParsedChunk[] {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') return this.parseJSON(content, filePath);
    if (ext === '.yaml' || ext === '.yml') return this.parseYAML(content, filePath);
    if (ext === '.env') return this.parseEnv(content, filePath);

    // Fallback: treat as single chunk
    return this.singleChunk(content, filePath, ext);
  }

  private parseJSON(content: string, filePath: string): ParsedChunk[] {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) {
        return this.singleChunk(content, filePath, '.json');
      }

      const chunks: ParsedChunk[] = [];
      const lines = content.split('\n');

      // Each top-level key becomes a chunk
      for (const key of Object.keys(parsed)) {
        const keyStr = JSON.stringify({ [key]: parsed[key] }, null, 2);
        // Find approximate line number
        const lineIdx = lines.findIndex((l) => l.includes(`"${key}"`));

        chunks.push({
          content: keyStr,
          startLine: Math.max(lineIdx + 1, 1),
          endLine: Math.max(lineIdx + 1, 1) + keyStr.split('\n').length - 1,
          language: 'json',
          type: 'config',
          symbols: [key],
        });
      }

      return chunks.length > 0 ? chunks : this.singleChunk(content, filePath, '.json');
    } catch {
      return this.singleChunk(content, filePath, '.json');
    }
  }

  private parseYAML(content: string, filePath: string): ParsedChunk[] {
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    let currentKey = '';
    let currentStart = 0;
    let currentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Top-level key: no leading whitespace, ends with ':'
      if (/^[a-zA-Z_][\w.-]*\s*:/.test(line)) {
        // Save previous chunk
        if (currentLines.length > 0 && currentKey) {
          chunks.push({
            content: currentLines.join('\n'),
            startLine: currentStart + 1,
            endLine: i,
            language: 'yaml',
            type: 'config',
            symbols: [currentKey],
          });
        }

        currentKey = line.split(':')[0].trim();
        currentStart = i;
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    // Last chunk
    if (currentLines.length > 0 && currentKey) {
      chunks.push({
        content: currentLines.join('\n'),
        startLine: currentStart + 1,
        endLine: lines.length,
        language: 'yaml',
        type: 'config',
        symbols: [currentKey],
      });
    }

    return chunks.length > 0 ? chunks : this.singleChunk(content, filePath, '.yaml');
  }

  private parseEnv(content: string, filePath: string): ParsedChunk[] {
    // Group env vars into logical blocks separated by comments or blank lines
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    let currentLines: string[] = [];
    let currentStart = 0;
    const symbols: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line === '' && currentLines.length > 0) {
        chunks.push({
          content: currentLines.join('\n'),
          startLine: currentStart + 1,
          endLine: i,
          language: 'env',
          type: 'config',
          symbols: [...symbols],
        });
        currentLines = [];
        symbols.length = 0;
        currentStart = i + 1;
      } else if (line) {
        currentLines.push(lines[i]);
        const varMatch = line.match(/^([A-Z_][A-Z0-9_]*)=/);
        if (varMatch) symbols.push(varMatch[1]);
      }
    }

    if (currentLines.length > 0) {
      chunks.push({
        content: currentLines.join('\n'),
        startLine: currentStart + 1,
        endLine: lines.length,
        language: 'env',
        type: 'config',
        symbols: [...symbols],
      });
    }

    return chunks.length > 0 ? chunks : this.singleChunk(content, filePath, '.env');
  }

  private singleChunk(content: string, filePath: string, ext: string): ParsedChunk[] {
    const langMap: Record<string, string> = {
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.json': 'json',
      '.toml': 'toml',
      '.env': 'env',
      '.hcl': 'hcl',
      '.ini': 'ini',
      '.cfg': 'config',
      '.conf': 'config',
    };

    return [
      {
        content,
        startLine: 1,
        endLine: content.split('\n').length,
        language: langMap[ext] || 'config',
        type: 'config',
      },
    ];
  }
}

export const configParser = new ConfigParser();
