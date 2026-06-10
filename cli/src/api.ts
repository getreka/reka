/**
 * API client for Reka CLI
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { RekaConfig } from "./config";

export function createClient(config: RekaConfig): AxiosInstance {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Project-Name": config.project.name,
    "X-Project-Path": config.project.path,
  };

  if (config.api.key) {
    headers["Authorization"] = `Bearer ${config.api.key}`;
  }

  return axios.create({
    baseURL: config.api.url,
    timeout: 120000,
    headers,
  });
}

export function formatError(err: unknown): string {
  if (err instanceof AxiosError) {
    if (err.code === "ECONNREFUSED") {
      return `Cannot connect to Reka API at ${err.config?.baseURL}. Is it running?`;
    }
    if (err.response) {
      const data = err.response.data as any;
      return data?.error || data?.message || `HTTP ${err.response.status}`;
    }
  }
  return (err as Error).message || String(err);
}
