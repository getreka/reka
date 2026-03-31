/**
 * Streamable HTTP transport for MCP server.
 * Enables dashboard and remote clients to connect over HTTP.
 *
 * Env:
 *   MCP_TRANSPORT   — stdio | http | both (default: stdio)
 *   MCP_HTTP_PORT   — port for HTTP transport (default: 3101)
 *   RAG_API_KEY     — required for Bearer auth when HTTP is enabled
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpTransportConfig {
  port: number;
  apiKey?: string;
}

export async function startHttpTransport(
  server: McpServer,
  config: HttpTransportConfig,
): Promise<void> {
  // Per-session transport instances
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!config.apiKey) return true;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.apiKey}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }
    return true;
  }

  function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString();
          resolve(body ? JSON.parse(body) : undefined);
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req, res) => {
    // Only handle /mcp path
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (!checkAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await parseBody(req).catch(() => undefined);
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        // New session — create transport and connect to MCP server
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            transports.delete(transport!.sessionId);
          }
        };

        await server.connect(transport);

        if (transport.sessionId) {
          transports.set(transport.sessionId, transport);
        }
      }

      await transport.handleRequest(req, res, body);
    } else if (req.method === "GET") {
      // SSE stream for server-initiated messages
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      // Close session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          await transport.close();
          transports.delete(sessionId);
        }
      }
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  });

  httpServer.listen(config.port, "127.0.0.1", () => {
    console.error(
      `MCP HTTP transport listening on http://127.0.0.1:${config.port}/mcp`,
    );
  });
}
