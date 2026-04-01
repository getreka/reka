/**
 * Docs Parser - Splits markdown/rst by headers into sections.
 */

import * as path from 'path';
import type { FileParser, ParsedChunk } from './base-parser';

const DOCS_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);

export class DocsParser implements FileParser {
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return DOCS_EXTENSIONS.has(ext);
  }

  parse(content: string, filePath: string): ParsedChunk[] {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.md' || ext === '.mdx') return this.parseMarkdown(content);
    if (ext === '.rst') return this.parseRST(content);

    // Fallback
    return [
      {
        content,
        startLine: 1,
        endLine: content.split('\n').length,
        language: 'text',
        type: 'docs',
      },
    ];
  }

  private parseMarkdown(content: string): ParsedChunk[] {
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    let currentTitle = '';
    let currentStart = 0;
    let currentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headerMatch = line.match(/^(#{1,6})\s+(.+)/);

      if (headerMatch) {
        // Save previous section
        if (currentLines.length > 0) {
          const chunkContent = currentLines.join('\n').trim();
          if (chunkContent.length >= 10) {
            chunks.push({
              content: chunkContent,
              startLine: currentStart + 1,
              endLine: i,
              language: 'markdown',
              type: 'docs',
              symbols: currentTitle ? [currentTitle] : undefined,
            });
          }
        }

        currentTitle = headerMatch[2].trim();
        currentStart = i;
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    // Last section
    if (currentLines.length > 0) {
      const chunkContent = currentLines.join('\n').trim();
      if (chunkContent.length >= 10) {
        chunks.push({
          content: chunkContent,
          startLine: currentStart + 1,
          endLine: lines.length,
          language: 'markdown',
          type: 'docs',
          symbols: currentTitle ? [currentTitle] : undefined,
        });
      }
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            content,
            startLine: 1,
            endLine: lines.length,
            language: 'markdown',
            type: 'docs',
          },
        ];
  }

  private parseRST(content: string): ParsedChunk[] {
    const lines = content.split('\n');
    const chunks: ParsedChunk[] = [];
    const rstUnderlines = /^[=\-~^"'+#*]{3,}$/;
    let currentTitle = '';
    let currentStart = 0;
    let currentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && rstUnderlines.test(lines[i].trim()) && lines[i - 1].trim().length > 0) {
        // Previous line is a title
        if (currentLines.length > 1) {
          const chunkContent = currentLines.slice(0, -1).join('\n').trim();
          if (chunkContent.length >= 10) {
            chunks.push({
              content: chunkContent,
              startLine: currentStart + 1,
              endLine: i - 1,
              language: 'rst',
              type: 'docs',
              symbols: currentTitle ? [currentTitle] : undefined,
            });
          }
        }

        currentTitle = lines[i - 1].trim();
        currentStart = i - 1;
        currentLines = [lines[i - 1], lines[i]];
      } else {
        currentLines.push(lines[i]);
      }
    }

    if (currentLines.length > 0) {
      const chunkContent = currentLines.join('\n').trim();
      if (chunkContent.length >= 10) {
        chunks.push({
          content: chunkContent,
          startLine: currentStart + 1,
          endLine: lines.length,
          language: 'rst',
          type: 'docs',
          symbols: currentTitle ? [currentTitle] : undefined,
        });
      }
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            content,
            startLine: 1,
            endLine: lines.length,
            language: 'rst',
            type: 'docs',
          },
        ];
  }
}

export const docsParser = new DocsParser();
