/**
 * CLI configuration loader
 * Reads reka.config.yaml → env vars → defaults
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

export interface RekaConfig {
  api: {
    url: string;
    key?: string;
  };
  project: {
    name: string;
    path: string;
  };
  models?: {
    embeddings?: {
      provider: string;
      model?: string;
      url?: string;
      dimensions?: number;
    };
    llm?: {
      utility?: { provider: string; model?: string; url?: string };
      standard?: { provider: string; model?: string; url?: string };
      complex?: { provider: string; model?: string; url?: string };
    };
  };
}

const CONFIG_FILES = ["reka.config.yaml", "reka.config.yml", ".rekarc.yaml"];

function findConfigFile(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    for (const name of CONFIG_FILES) {
      const filePath = path.join(dir, name);
      if (fs.existsSync(filePath)) return filePath;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Check home directory
  const homeConfig = path.join(
    process.env.HOME || "~",
    ".config",
    "reka",
    "config.yaml",
  );
  if (fs.existsSync(homeConfig)) return homeConfig;
  return null;
}

export function loadConfig(overrides?: Partial<RekaConfig>): RekaConfig {
  const configFile = findConfigFile(process.cwd());
  let fileConfig: Record<string, any> = {};

  if (configFile) {
    try {
      const raw = fs.readFileSync(configFile, "utf-8");
      fileConfig = (yaml.load(raw) as Record<string, any>) || {};
    } catch {
      // Silently ignore malformed config
    }
  }

  const projectName =
    overrides?.project?.name ||
    fileConfig.project?.name ||
    process.env.REKA_PROJECT ||
    path.basename(process.cwd());

  const config: RekaConfig = {
    api: {
      url:
        overrides?.api?.url ||
        fileConfig.api?.url ||
        process.env.REKA_API_URL ||
        process.env.RAG_API_URL ||
        "http://localhost:3100",
      key:
        overrides?.api?.key ||
        fileConfig.api?.key ||
        process.env.REKA_API_KEY ||
        process.env.RAG_API_KEY,
    },
    project: {
      name: projectName,
      path:
        overrides?.project?.path ||
        fileConfig.project?.path ||
        process.env.REKA_PROJECT_PATH ||
        process.cwd(),
    },
    models: fileConfig.models || overrides?.models,
  };

  return config;
}

export function getConfigFilePath(): string | null {
  return findConfigFile(process.cwd());
}
