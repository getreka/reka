import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageConnection,
} from 'vscode-jsonrpc/node';
import config from '../config';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Language server configuration
// ---------------------------------------------------------------------------

interface LSPServerConfig {
  command: string;
  args: string[];
  languages: string[];
}

const SERVER_CONFIGS: LSPServerConfig[] = [
  {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    command: 'gopls',
    args: ['serve'],
    languages: ['.go'],
  },
  {
    command: 'pyright-langserver',
    args: ['--stdio'],
    languages: ['.py'],
  },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LSPLocation {
  file: string;
  line: number;
  character: number;
}

export interface LSPSymbol {
  name: string;
  kind: number;
  file: string;
  startLine: number;
  endLine: number;
  containerName?: string;
}

export interface LSPHoverResult {
  content: string;
  range?: { startLine: number; endLine: number };
}

export interface LSPCallItem {
  name: string;
  file: string;
  line: number;
  character: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ServerConnection {
  process: ChildProcess;
  connection: MessageConnection;
  openedFiles: Set<string>;
  lastActivity: number;
  initialized: boolean;
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath);
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.go':
      return 'go';
    case '.py':
      return 'python';
    default:
      return 'plaintext';
  }
}

function resolveProjectRoot(filePath: string, hint?: string): string {
  if (hint) return hint;
  // Walk up from the file's directory looking for package.json or tsconfig.json
  let dir = path.dirname(filePath);
  const markers = ['package.json', 'tsconfig.json', 'go.mod', 'pyproject.toml', 'setup.py'];
  for (let i = 0; i < 10; i++) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(filePath);
}

function parseLocations(result: any): LSPLocation[] {
  if (!result) return [];
  const locations = Array.isArray(result) ? result : [result];
  return locations
    .map((loc: any) => {
      try {
        const uri: string = loc.uri ?? loc.targetUri ?? '';
        const range = loc.range ?? loc.targetRange;
        return {
          file: new URL(uri).pathname,
          line: range?.start?.line ?? 0,
          character: range?.start?.character ?? 0,
        };
      } catch {
        return null;
      }
    })
    .filter((l): l is LSPLocation => l !== null);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class LSPClientService {
  private servers = new Map<string, ServerConnection>();

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  async ensureServer(language: string, projectPath: string): Promise<boolean> {
    const key = this.serverKey(language);
    if (this.servers.has(key)) return true;

    const cfg = SERVER_CONFIGS.find((c) => c.languages.includes(language));
    if (!cfg) {
      logger.debug('LSP: no server configured for language', { language });
      return false;
    }

    if (!commandExists(cfg.command)) {
      logger.debug('LSP: command not found', { command: cfg.command });
      return false;
    }

    try {
      const child = spawn(cfg.command, cfg.args, { stdio: 'pipe' });
      const connection = createMessageConnection(
        new StreamMessageReader(child.stdout!),
        new StreamMessageWriter(child.stdin!)
      );
      connection.listen();

      const server: ServerConnection = {
        process: child,
        connection,
        openedFiles: new Set(),
        lastActivity: Date.now(),
        initialized: false,
        projectRoot: projectPath,
      };

      await Promise.race([
        this.initializeServer(server, projectPath),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LSP startup timeout')), config.LSP_STARTUP_TIMEOUT_MS)
        ),
      ]);

      server.initialized = true;
      this.servers.set(key, server);
      this.startIdleTimer(key);

      child.on('exit', (code) => {
        logger.debug('LSP server exited', { key, code });
        this.servers.delete(key);
      });

      logger.info('LSP server started', { command: cfg.command, projectPath });
      return true;
    } catch (err: any) {
      logger.warn('LSP server failed to start', { language, error: err.message });
      return false;
    }
  }

  private async initializeServer(server: ServerConnection, projectRoot: string): Promise<void> {
    await server.connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: `file://${projectRoot}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
    });
    server.connection.sendNotification('initialized', {});
  }

  private async openFile(server: ServerConnection, filePath: string): Promise<void> {
    if (server.openedFiles.has(filePath)) return;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    const uri = `file://${filePath}`;
    const languageId = getLanguageId(filePath);
    server.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
    server.openedFiles.add(filePath);
  }

  private async shutdownServer(key: string): Promise<void> {
    const server = this.servers.get(key);
    if (!server) return;
    try {
      await server.connection.sendRequest('shutdown');
      server.connection.sendNotification('exit');
      server.process.kill();
    } catch {
      // best-effort
    }
    this.servers.delete(key);
  }

  private startIdleTimer(key: string): void {
    const timer = setInterval(() => {
      const server = this.servers.get(key);
      if (server && Date.now() - server.lastActivity > config.LSP_IDLE_SHUTDOWN_MS) {
        logger.debug('LSP server idle shutdown', { key });
        this.shutdownServer(key);
        clearInterval(timer);
      }
    }, 60000);
    timer.unref();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private serverKey(language: string): string {
    const cfg = SERVER_CONFIGS.find((c) => c.languages.includes(language));
    return cfg ? cfg.command : language;
  }

  private async getServer(ext: string, projectPath: string): Promise<ServerConnection | null> {
    const cfg = SERVER_CONFIGS.find((c) => c.languages.includes(ext));
    if (!cfg) return null;
    const key = cfg.command;
    if (this.servers.has(key)) {
      const server = this.servers.get(key)!;
      server.lastActivity = Date.now();
      return server;
    }
    const started = await this.ensureServer(ext, projectPath);
    if (!started) return null;
    return this.servers.get(key) ?? null;
  }

  private async sendRequest(server: ServerConnection, method: string, params: any): Promise<any> {
    server.lastActivity = Date.now();
    return Promise.race([
      server.connection.sendRequest(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`LSP request timeout: ${method}`)),
          config.LSP_REQUEST_TIMEOUT_MS
        )
      ),
    ]);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async goToDefinition(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPLocation[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const result = await this.sendRequest(server, 'textDocument/definition', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      return parseLocations(result);
    } catch (err: any) {
      logger.debug('LSP goToDefinition failed', { error: err.message, file: filePath });
      return null;
    }
  }

  async findReferences(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPLocation[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const result = await this.sendRequest(server, 'textDocument/references', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
        context: { includeDeclaration: false },
      });
      return parseLocations(result);
    } catch (err: any) {
      logger.debug('LSP findReferences failed', { error: err.message, file: filePath });
      return null;
    }
  }

  async goToImplementation(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPLocation[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const result = await this.sendRequest(server, 'textDocument/implementation', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      return parseLocations(result);
    } catch (err: any) {
      logger.debug('LSP goToImplementation failed', { error: err.message, file: filePath });
      return null;
    }
  }

  async incomingCalls(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPCallItem[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const items = await this.sendRequest(server, 'textDocument/prepareCallHierarchy', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      if (!items || !Array.isArray(items) || items.length === 0) return null;
      const calls = await this.sendRequest(server, 'callHierarchy/incomingCalls', {
        item: items[0],
      });
      if (!calls) return null;
      return calls
        .map((c: any) => {
          try {
            return {
              name: c.from?.name ?? '',
              file: new URL(c.from?.uri ?? '').pathname,
              line: c.from?.range?.start?.line ?? 0,
              character: c.from?.range?.start?.character ?? 0,
            };
          } catch {
            return null;
          }
        })
        .filter((c: LSPCallItem | null): c is LSPCallItem => c !== null);
    } catch (err: any) {
      logger.debug('LSP incomingCalls failed', { error: err.message, file: filePath });
      return null;
    }
  }

  async outgoingCalls(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPCallItem[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const items = await this.sendRequest(server, 'textDocument/prepareCallHierarchy', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      if (!items || !Array.isArray(items) || items.length === 0) return null;
      const calls = await this.sendRequest(server, 'callHierarchy/outgoingCalls', {
        item: items[0],
      });
      if (!calls) return null;
      return calls
        .map((c: any) => {
          try {
            return {
              name: c.to?.name ?? '',
              file: new URL(c.to?.uri ?? '').pathname,
              line: c.to?.range?.start?.line ?? 0,
              character: c.to?.range?.start?.character ?? 0,
            };
          } catch {
            return null;
          }
        })
        .filter((c: LSPCallItem | null): c is LSPCallItem => c !== null);
    } catch (err: any) {
      logger.debug('LSP outgoingCalls failed', { error: err.message, file: filePath });
      return null;
    }
  }

  async documentSymbol(filePath: string, projectPath?: string): Promise<LSPSymbol[] | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const result = await this.sendRequest(server, 'textDocument/documentSymbol', {
        textDocument: { uri: `file://${filePath}` },
      });
      if (!result || !Array.isArray(result)) return null;
      return this.flattenDocumentSymbols(result, filePath);
    } catch (err: any) {
      logger.debug('LSP documentSymbol failed', { error: err.message, file: filePath });
      return null;
    }
  }

  private flattenDocumentSymbols(
    symbols: any[],
    filePath: string,
    containerName?: string
  ): LSPSymbol[] {
    const result: LSPSymbol[] = [];
    for (const sym of symbols) {
      // DocumentSymbol has selectionRange + children; SymbolInformation has location
      const startLine: number = sym.range?.start?.line ?? sym.location?.range?.start?.line ?? 0;
      const endLine: number = sym.range?.end?.line ?? sym.location?.range?.end?.line ?? startLine;
      result.push({
        name: sym.name,
        kind: sym.kind,
        file: filePath,
        startLine,
        endLine,
        containerName: containerName ?? sym.containerName,
      });
      if (sym.children && Array.isArray(sym.children)) {
        result.push(...this.flattenDocumentSymbols(sym.children, filePath, sym.name));
      }
    }
    return result;
  }

  async workspaceSymbol(
    query: string,
    language: string,
    projectPath?: string
  ): Promise<LSPSymbol[] | null> {
    if (!config.LSP_ENABLED) return null;
    const ext = SERVER_CONFIGS.find((c) =>
      c.languages.some((l) => getLanguageId(`x${l}`) === language || c.command.includes(language))
    )?.languages[0];
    const root = projectPath ?? process.cwd();
    const server = await this.getServer(ext ?? language, root);
    if (!server) return null;
    try {
      const result = await this.sendRequest(server, 'workspace/symbol', { query });
      if (!result || !Array.isArray(result)) return null;
      return result
        .map((sym: any): LSPSymbol | null => {
          try {
            const filePath = new URL(sym.location?.uri ?? '').pathname;
            return {
              name: sym.name,
              kind: sym.kind,
              file: filePath,
              startLine: sym.location?.range?.start?.line ?? 0,
              endLine: sym.location?.range?.end?.line ?? 0,
              containerName: sym.containerName,
            };
          } catch {
            return null;
          }
        })
        .filter((s: LSPSymbol | null): s is LSPSymbol => s !== null);
    } catch (err: any) {
      logger.debug('LSP workspaceSymbol failed', { error: err.message, query });
      return null;
    }
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
    projectPath?: string
  ): Promise<LSPHoverResult | null> {
    if (!config.LSP_ENABLED) return null;
    const root = resolveProjectRoot(filePath, projectPath);
    const server = await this.getServer(path.extname(filePath), root);
    if (!server) return null;
    try {
      await this.openFile(server, filePath);
      const result = await this.sendRequest(server, 'textDocument/hover', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      if (!result) return null;
      const content =
        typeof result.contents === 'string'
          ? result.contents
          : (result.contents?.value ?? result.contents?.kind === 'markdown')
            ? result.contents.value
            : JSON.stringify(result.contents);
      return {
        content,
        range: result.range
          ? {
              startLine: result.range.start?.line ?? 0,
              endLine: result.range.end?.line ?? 0,
            }
          : undefined,
      };
    } catch (err: any) {
      logger.debug('LSP hover failed', { error: err.message, file: filePath });
      return null;
    }
  }

  /**
   * Returns true if an LSP server is configured and its command is available
   * for the given file extension.
   */
  isAvailable(ext: string): boolean {
    if (!config.LSP_ENABLED) return false;
    const cfg = SERVER_CONFIGS.find((c) => c.languages.includes(ext));
    if (!cfg) return false;
    return commandExists(cfg.command);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(language?: string): Promise<void> {
    if (language) {
      const key = this.serverKey(language);
      await this.shutdownServer(key);
    } else {
      for (const key of this.servers.keys()) {
        await this.shutdownServer(key);
      }
    }
  }
}

export const lspClient = new LSPClientService();
