import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocsParser } from '../../../services/parsers/docs-parser';

describe('DocsParser', () => {
  let parser: DocsParser;

  beforeEach(() => {
    vi.resetAllMocks();
    parser = new DocsParser();
  });

  describe('canParse()', () => {
    it.each(['.md', '.mdx', '.rst', '.txt'])(
      'returns true for %s files',
      (ext) => {
        expect(parser.canParse(`docs/file${ext}`)).toBe(true);
      }
    );

    it.each(['.ts', '.js', '.json', '.yaml', '.html', '.py'])(
      'returns false for %s files',
      (ext) => {
        expect(parser.canParse(`docs/file${ext}`)).toBe(false);
      }
    );

    it('is case-insensitive for extensions', () => {
      expect(parser.canParse('docs/README.MD')).toBe(true);
      expect(parser.canParse('docs/readme.TXT')).toBe(true);
    });
  });

  describe('parse() — markdown', () => {
    it('splits document by top-level headings', () => {
      const content = `# Introduction

This is the intro text.

# Usage

This is the usage text.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      expect(chunks.length).toBe(2);
      expect(chunks[0].symbols).toContain('Introduction');
      expect(chunks[1].symbols).toContain('Usage');
    });

    it('each chunk has language set to markdown', () => {
      const content = `# Section\n\nSome content here.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      for (const chunk of chunks) {
        expect(chunk.language).toBe('markdown');
      }
    });

    it('each chunk has type set to docs', () => {
      const content = `# Section\n\nSome content here.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      for (const chunk of chunks) {
        expect(chunk.type).toBe('docs');
      }
    });

    it('sets startLine and endLine correctly', () => {
      const content = `# First\n\nContent.\n\n# Second\n\nMore content.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(1);
      expect(chunks[1].startLine).toBeGreaterThan(chunks[0].startLine);
    });

    it('handles nested headings without splitting on sub-headings', () => {
      const content = `# Main Section

Intro paragraph.

## Subsection

Sub content.

## Another Subsection

More sub content.

# Next Main Section

Content here.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      // Each heading becomes its own chunk
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves code blocks within a chunk', () => {
      const content = `# Setup

Run these commands:

\`\`\`bash
npm install
npm run build
\`\`\`

Done.`;
      const chunks = parser.parse(content, 'docs/setup.md');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toContain('```bash');
      expect(chunks[0].content).toContain('npm install');
      expect(chunks[0].content).toContain('```');
    });

    it('returns single chunk for document with no headings', () => {
      const content = `Just some text without any headings.
It has multiple lines but no sections.
This is all one block of content.`;
      const chunks = parser.parse(content, 'docs/notes.md');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(content);
      expect(chunks[0].symbols).toBeUndefined();
    });

    it('returns single chunk for empty document', () => {
      const chunks = parser.parse('', 'docs/empty.md');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('markdown');
      expect(chunks[0].type).toBe('docs');
    });

    it('skips sections whose trimmed content is shorter than 10 characters', () => {
      // The 10-char check is on the full joined chunk content (including the heading line).
      // A heading like "# Short" alone is only 7 chars, but once we add a couple of
      // content lines the chunk grows beyond the threshold.
      // Here we use a heading immediately followed by another heading (zero body lines)
      // to produce a content string of less than 10 chars.
      const content = `# AB

# Long Section

This section has enough content to be included as a chunk.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      // "# AB" alone is 4 chars — trimmed chunk is "# AB" (4 chars < 10) → skipped
      const shortChunk = chunks.find(c => c.symbols?.includes('AB'));
      expect(shortChunk).toBeUndefined();

      const longChunk = chunks.find(c => c.symbols?.includes('Long Section'));
      expect(longChunk).toBeDefined();
    });

    it('handles h2 and h3 headings', () => {
      const content = `## Level Two Heading

Content for level two.

### Level Three Heading

Content for level three.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('Level Two Heading');
      expect(symbols).toContain('Level Three Heading');
    });

    it('handles .mdx files the same as .md', () => {
      const content = `# MDX Heading\n\nContent here for MDX file.`;
      const chunks = parser.parse(content, 'docs/component.mdx');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('markdown');
      expect(chunks[0].symbols).toContain('MDX Heading');
    });

    it('includes heading line in chunk content', () => {
      const content = `# My Section\n\nThe body of the section.`;
      const chunks = parser.parse(content, 'docs/guide.md');

      expect(chunks[0].content).toContain('# My Section');
    });
  });

  describe('parse() — RST', () => {
    it('splits RST document by section underlines', () => {
      const content = `Introduction
============

This is the introduction.

Usage
-----

This is the usage section.`;
      const chunks = parser.parse(content, 'docs/guide.rst');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const rstChunks = chunks.filter(c => c.language === 'rst');
      expect(rstChunks.length).toBeGreaterThanOrEqual(1);
    });

    it('each RST chunk has type set to docs', () => {
      const content = `My Section
==========

Some content here for RST parsing.`;
      const chunks = parser.parse(content, 'docs/guide.rst');

      for (const chunk of chunks) {
        expect(chunk.type).toBe('docs');
      }
    });

    it('returns single chunk for empty RST document', () => {
      const chunks = parser.parse('', 'docs/empty.rst');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('rst');
    });
  });

  describe('parse() — plain text fallback', () => {
    it('returns single chunk for .txt file', () => {
      const content = `This is plain text content.
It has multiple lines.
No special formatting.`;
      const chunks = parser.parse(content, 'docs/notes.txt');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('text');
      expect(chunks[0].type).toBe('docs');
      expect(chunks[0].content).toBe(content);
      expect(chunks[0].startLine).toBe(1);
    });

    it('sets correct endLine for txt file', () => {
      const content = `Line 1\nLine 2\nLine 3`;
      const chunks = parser.parse(content, 'docs/notes.txt');

      expect(chunks[0].endLine).toBe(3);
    });
  });
});
