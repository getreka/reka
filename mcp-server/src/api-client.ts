/**
 * API Client — lightweight fetch-based HTTP client for RAG API calls.
 * Drop-in replacement for axios with identical interface at call sites:
 *   ctx.api.post(path, data)  →  { data: T }
 *   ctx.api.get(path)         →  { data: T }
 *   err.response.status / err.code — same shape as AxiosError
 *
 * Phase 5: Unix domain socket support via API_SOCKET_PATH env var.
 */

import { Pool } from "undici";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ApiResponse<T = any> {
  data: T;
  status: number;
  headers: Headers;
}

export class ApiError extends Error {
  code?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response?: { status: number; data: any };

  constructor(
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts?: { code?: string; status?: number; data?: any },
  ) {
    super(message);
    this.name = "ApiError";
    if (opts?.code) this.code = opts.code;
    if (opts?.status !== undefined) {
      this.response = { status: opts.status, data: opts.data };
    }
  }
}

interface RequestConfig {
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export class ApiClient {
  readonly defaults: { baseURL: string };
  private _headers: Record<string, string>;
  private _timeout: number;
  private _pool?: Pool;

  constructor(
    baseURL: string,
    timeout: number,
    headers: Record<string, string>,
    socketPath?: string,
  ) {
    this.defaults = { baseURL };
    this._headers = headers;
    this._timeout = timeout;

    // Phase 5: Unix domain socket — use undici Pool with socketPath
    if (socketPath) {
      this._pool = new Pool("http://localhost", {
        socketPath,
        connections: 10,
        keepAliveTimeout: 30_000,
      });
    }
  }

  setProjectName(name: string): void {
    this._headers["X-Project-Name"] = name;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get<T = any>(
    path: string,
    config?: RequestConfig,
  ): Promise<ApiResponse<T>> {
    return this._request<T>("GET", path, undefined, config);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async post<T = any>(
    path: string,
    data?: unknown,
    config?: RequestConfig,
  ): Promise<ApiResponse<T>> {
    return this._request<T>("POST", path, data, config);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async patch<T = any>(
    path: string,
    data?: unknown,
    config?: RequestConfig,
  ): Promise<ApiResponse<T>> {
    return this._request<T>("PATCH", path, data, config);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async delete<T = any>(
    path: string,
    config?: RequestConfig,
  ): Promise<ApiResponse<T>> {
    return this._request<T>("DELETE", path, undefined, config);
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    config?: RequestConfig,
  ): Promise<ApiResponse<T>> {
    const timeout = config?.timeout ?? this._timeout;
    const signal = config?.signal ?? AbortSignal.timeout(timeout);
    const headers = { ...this._headers, ...config?.headers };

    // Phase 5: Unix socket path — use undici Pool directly
    if (this._pool) {
      return this._requestViaPool<T>(method, path, body, headers, signal);
    }

    // Standard fetch path (TCP)
    const url = `${this.defaults.baseURL}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err: unknown) {
      throw this._mapNetworkError(err, timeout);
    }

    const data = (await res.json().catch(() => null)) as T;

    if (!res.ok) {
      throw new ApiError(`Request failed with status ${res.status}`, {
        status: res.status,
        data,
      });
    }

    return { data, status: res.status, headers: res.headers };
  }

  /** Unix socket request via undici Pool */
  private async _requestViaPool<T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ApiResponse<T>> {
    try {
      const {
        statusCode,
        headers: resHeaders,
        body: resBody,
      } = await this._pool!.request({
        method,
        path,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });

      const text = await resBody.text();
      const data = text ? (JSON.parse(text) as T) : (null as T);

      if (statusCode >= 400) {
        throw new ApiError(`Request failed with status ${statusCode}`, {
          status: statusCode,
          data,
        });
      }

      // Convert undici headers to standard Headers
      const stdHeaders = new Headers();
      for (const [key, val] of Object.entries(resHeaders)) {
        if (val) stdHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
      }

      return { data, status: statusCode, headers: stdHeaders };
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      throw this._mapNetworkError(err, this._timeout);
    }
  }

  /** Map network errors to axios-compatible ApiError */
  private _mapNetworkError(err: unknown, timeout: number): ApiError {
    const e = err as {
      cause?: { code?: string };
      message?: string;
      name?: string;
    };
    if (
      e.cause?.code === "ECONNREFUSED" ||
      e.message?.includes("ECONNREFUSED")
    ) {
      return new ApiError("connect ECONNREFUSED", { code: "ECONNREFUSED" });
    }
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      return new ApiError(`timeout of ${timeout}ms exceeded`, {
        code: "ECONNABORTED",
      });
    }
    return new ApiError(e.message || String(err), { code: e.cause?.code });
  }
}

export function createApiClient(
  ragApiUrl: string,
  projectName: string,
  projectPath: string,
  apiKey?: string,
): ApiClient {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Project-Name": projectName,
    "X-Project-Path": projectPath,
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Phase 5: Use Unix socket if API_SOCKET_PATH is set
  const socketPath = process.env.API_SOCKET_PATH;
  return new ApiClient(ragApiUrl, 120_000, headers, socketPath);
}
