import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigParser } from '../../../services/parsers/config-parser';

describe('ConfigParser', () => {
  let parser: ConfigParser;

  beforeEach(() => {
    vi.resetAllMocks();
    parser = new ConfigParser();
  });

  describe('canParse()', () => {
    it.each(['.yaml', '.yml', '.json', '.toml', '.env', '.hcl', '.ini', '.cfg', '.conf'])(
      'returns true for %s files',
      (ext) => {
        expect(parser.canParse(`config/file${ext}`)).toBe(true);
      }
    );

    it.each(['.ts', '.js', '.md', '.txt', '.py', '.go'])(
      'returns false for %s files',
      (ext) => {
        expect(parser.canParse(`config/file${ext}`)).toBe(false);
      }
    );

    it('is case-insensitive for extensions', () => {
      expect(parser.canParse('config/app.YAML')).toBe(true);
      expect(parser.canParse('config/app.JSON')).toBe(true);
    });
  });

  describe('parse() — JSON', () => {
    it('creates one chunk per top-level key', () => {
      const content = JSON.stringify({
        name: 'my-app',
        version: '1.0.0',
        port: 3000,
      }, null, 2);

      const chunks = parser.parse(content, 'config/package.json');

      expect(chunks.length).toBe(3);
      const keys = chunks.flatMap(c => c.symbols ?? []);
      expect(keys).toContain('name');
      expect(keys).toContain('version');
      expect(keys).toContain('port');
    });

    it('each JSON chunk has language set to json', () => {
      const content = JSON.stringify({ host: 'localhost', port: 3100 }, null, 2);
      const chunks = parser.parse(content, 'config/app.json');

      for (const chunk of chunks) {
        expect(chunk.language).toBe('json');
      }
    });

    it('each JSON chunk has type set to config', () => {
      const content = JSON.stringify({ host: 'localhost' }, null, 2);
      const chunks = parser.parse(content, 'config/app.json');

      for (const chunk of chunks) {
        expect(chunk.type).toBe('config');
      }
    });

    it('chunk content is a serialized JSON object for the key', () => {
      const content = JSON.stringify({ dependencies: { express: '^4.18.0' } }, null, 2);
      const chunks = parser.parse(content, 'config/package.json');

      expect(chunks).toHaveLength(1);
      const parsed = JSON.parse(chunks[0].content);
      expect(parsed).toHaveProperty('dependencies');
      expect(parsed.dependencies).toHaveProperty('express');
    });

    it('handles nested objects as a single chunk per top-level key', () => {
      const content = JSON.stringify({
        server: { host: 'localhost', port: 8080 },
        database: { url: 'postgres://localhost/db' },
      }, null, 2);

      const chunks = parser.parse(content, 'config/app.json');

      expect(chunks.length).toBe(2);
      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('server');
      expect(symbols).toContain('database');
    });

    it('returns single chunk for invalid JSON', () => {
      const content = `{ invalid json content here`;
      const chunks = parser.parse(content, 'config/broken.json');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(content);
      expect(chunks[0].language).toBe('json');
    });

    it('creates index-keyed chunks for JSON array (Object.keys behaviour)', () => {
      // Arrays are typeof object and non-null, so Object.keys produces index keys '0','1','2'
      const content = JSON.stringify([1, 2, 3]);
      const chunks = parser.parse(content, 'config/list.json');

      expect(chunks.length).toBe(3);
      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('0');
      expect(symbols).toContain('1');
      expect(symbols).toContain('2');
    });

    it('returns single chunk for null JSON', () => {
      const content = 'null';
      const chunks = parser.parse(content, 'config/null.json');

      expect(chunks).toHaveLength(1);
    });

    it('sets startLine and endLine on JSON chunks', () => {
      const content = JSON.stringify({ alpha: 1, beta: 2 }, null, 2);
      const chunks = parser.parse(content, 'config/app.json');

      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    });
  });

  describe('parse() — YAML', () => {
    it('creates one chunk per top-level key', () => {
      const content = `host: localhost
port: 3100
debug: true`;

      const chunks = parser.parse(content, 'config/app.yaml');

      expect(chunks.length).toBe(3);
      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('host');
      expect(symbols).toContain('port');
      expect(symbols).toContain('debug');
    });

    it('each YAML chunk has language set to yaml', () => {
      const content = `host: localhost\nport: 3100`;
      const chunks = parser.parse(content, 'config/app.yaml');

      for (const chunk of chunks) {
        expect(chunk.language).toBe('yaml');
      }
    });

    it('each YAML chunk has type set to config', () => {
      const content = `host: localhost\nport: 3100`;
      const chunks = parser.parse(content, 'config/app.yaml');

      for (const chunk of chunks) {
        expect(chunk.type).toBe('config');
      }
    });

    it('groups nested YAML under the top-level key', () => {
      const content = `database:
  host: localhost
  port: 5432
  name: mydb
server:
  port: 3100`;

      const chunks = parser.parse(content, 'config/app.yml');

      const dbChunk = chunks.find(c => c.symbols?.includes('database'));
      expect(dbChunk).toBeDefined();
      expect(dbChunk!.content).toContain('host: localhost');
      expect(dbChunk!.content).toContain('port: 5432');
    });

    it('handles .yml extension the same as .yaml', () => {
      const content = `key: value`;
      const chunks = parser.parse(content, 'config/app.yml');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('yaml');
    });

    it('sets correct line numbers for YAML chunks', () => {
      const content = `first: 1\nsecond: 2\nthird: 3`;
      const chunks = parser.parse(content, 'config/app.yaml');

      expect(chunks[0].startLine).toBe(1);
      expect(chunks[1].startLine).toBe(2);
      expect(chunks[2].startLine).toBe(3);
    });

    it('returns single chunk for YAML with no top-level keys', () => {
      const content = `  indented: value`;
      const chunks = parser.parse(content, 'config/app.yaml');

      // No top-level keys matching pattern → falls through to singleChunk
      expect(chunks).toHaveLength(1);
    });
  });

  describe('parse() — .env files', () => {
    // NOTE: path.extname('.env') returns '' (dotfiles have no extension).
    // Use 'app.env' (extension: '.env') so the parser routes to parseEnv().

    it('groups env vars separated by blank lines', () => {
      const content = `DB_HOST=localhost
DB_PORT=5432

APP_PORT=3100
APP_HOST=0.0.0.0`;

      const chunks = parser.parse(content, 'app.env');

      expect(chunks.length).toBe(2);
    });

    it('extracts env variable names as symbols', () => {
      const content = `DB_HOST=localhost\nDB_PORT=5432`;
      const chunks = parser.parse(content, 'app.env');

      expect(chunks[0].symbols).toContain('DB_HOST');
      expect(chunks[0].symbols).toContain('DB_PORT');
    });

    it('each env chunk has language set to env', () => {
      const content = `APP_PORT=3100`;
      const chunks = parser.parse(content, 'app.env');

      for (const chunk of chunks) {
        expect(chunk.language).toBe('env');
      }
    });

    it('each env chunk has type set to config', () => {
      const content = `APP_PORT=3100`;
      const chunks = parser.parse(content, 'app.env');

      for (const chunk of chunks) {
        expect(chunk.type).toBe('config');
      }
    });

    it('ignores comment lines when extracting symbols', () => {
      const content = `# Database settings\nDB_URL=postgres://localhost/db`;
      const chunks = parser.parse(content, 'app.env');

      expect(chunks[0].symbols).not.toContain('#');
      expect(chunks[0].symbols).toContain('DB_URL');
    });

    it('ignores lowercase variable names (not standard env)', () => {
      const content = `lowercase_var=value\nUPPERCASE_VAR=value`;
      const chunks = parser.parse(content, 'app.env');

      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('UPPERCASE_VAR');
      expect(symbols).not.toContain('lowercase_var');
    });

    it('handles .env file with only one group', () => {
      const content = `HOST=localhost\nPORT=3100\nDEBUG=true`;
      const chunks = parser.parse(content, 'app.env');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].symbols).toContain('HOST');
      expect(chunks[0].symbols).toContain('PORT');
      expect(chunks[0].symbols).toContain('DEBUG');
    });

    it('handles empty .env file gracefully', () => {
      const chunks = parser.parse('', 'app.env');

      // No lines → falls through to singleChunk
      expect(chunks).toHaveLength(1);
    });

    it('sets startLine and endLine on env chunks', () => {
      const content = `FIRST=1\nSECOND=2`;
      const chunks = parser.parse(content, 'app.env');

      expect(chunks[0].startLine).toBeGreaterThanOrEqual(1);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[0].startLine);
    });
  });

  describe('parse() — fallback formats', () => {
    it('returns single chunk for .toml files', () => {
      const content = `[package]\nname = "myapp"\nversion = "1.0.0"`;
      const chunks = parser.parse(content, 'config/Cargo.toml');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('toml');
      expect(chunks[0].type).toBe('config');
      expect(chunks[0].content).toBe(content);
    });

    it('returns single chunk for .ini files', () => {
      const content = `[section]\nkey=value`;
      const chunks = parser.parse(content, 'config/app.ini');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('ini');
    });

    it('returns single chunk for .conf files', () => {
      const content = `server_name localhost;\nlisten 80;`;
      const chunks = parser.parse(content, 'nginx/nginx.conf');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('config');
    });

    it('returns single chunk for .hcl files', () => {
      const content = `resource "aws_s3_bucket" "main" {\n  bucket = "my-bucket"\n}`;
      const chunks = parser.parse(content, 'infra/main.hcl');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('hcl');
    });

    it('fallback chunk has correct line count', () => {
      const content = `line1\nline2\nline3`;
      const chunks = parser.parse(content, 'config/app.toml');

      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(3);
    });
  });
});
