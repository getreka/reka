import chalk from "chalk";
import ora from "ora";
import axios from "axios";
import { RekaConfig } from "../config";
import { formatError } from "../api";

interface ProviderStatus {
  name: string;
  url: string;
  status: "healthy" | "unreachable" | "error";
  latency?: number;
  models?: string[];
}

async function checkProvider(
  name: string,
  url: string,
): Promise<ProviderStatus> {
  const start = Date.now();
  try {
    if (name === "ollama") {
      const { data } = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      return {
        name,
        url,
        status: "healthy",
        latency: Date.now() - start,
        models: (data.models || []).map((m: any) => m.name),
      };
    } else if (name === "bge-m3") {
      await axios.get(`${url}/health`, { timeout: 5000 });
      return { name, url, status: "healthy", latency: Date.now() - start };
    } else {
      await axios.get(url, { timeout: 5000 });
      return { name, url, status: "healthy", latency: Date.now() - start };
    }
  } catch {
    return { name, url, status: "unreachable", latency: Date.now() - start };
  }
}

export async function modelsListCommand(config: RekaConfig) {
  console.log(chalk.bold("\n  Model Providers\n"));

  const spinner = ora("Checking providers...").start();

  const checks: Promise<ProviderStatus>[] = [];

  // Always check default providers
  const ollamaUrl =
    config.models?.llm?.utility?.url || "http://localhost:11434";
  const bgeUrl = config.models?.embeddings?.url || "http://localhost:8080";

  checks.push(checkProvider("ollama", ollamaUrl));
  checks.push(checkProvider("bge-m3", bgeUrl));

  const results = await Promise.all(checks);
  spinner.stop();

  for (const r of results) {
    const icon = r.status === "healthy" ? chalk.green("●") : chalk.red("●");
    const latency = r.latency ? chalk.gray(`${r.latency}ms`) : "";
    console.log(
      `  ${icon} ${chalk.bold(r.name)} ${chalk.gray(r.url)} ${latency}`,
    );

    if (r.models && r.models.length > 0) {
      for (const m of r.models.slice(0, 10)) {
        console.log(`    ${chalk.gray("→")} ${m}`);
      }
      if (r.models.length > 10) {
        console.log(
          `    ${chalk.gray(`  ...and ${r.models.length - 10} more`)}`,
        );
      }
    }
  }

  // Show configured routing
  if (config.models?.llm) {
    console.log(chalk.bold("\n  Routing"));
    const llm = config.models.llm;
    if (llm.utility)
      console.log(
        `  Utility:  ${llm.utility.provider} / ${llm.utility.model || "default"}`,
      );
    if (llm.standard)
      console.log(
        `  Standard: ${llm.standard.provider} / ${llm.standard.model || "default"}`,
      );
    if (llm.complex)
      console.log(
        `  Complex:  ${llm.complex.provider} / ${llm.complex.model || "default"}`,
      );
  }

  console.log("");
}

export async function modelsTestCommand(config: RekaConfig) {
  console.log(chalk.bold("\n  Testing Model Connections\n"));

  const ollamaUrl =
    config.models?.llm?.utility?.url || "http://localhost:11434";
  const bgeUrl = config.models?.embeddings?.url || "http://localhost:8080";

  // Test embedding
  const embedSpinner = ora("Testing embeddings...").start();
  try {
    const start = Date.now();
    await axios.post(
      `${bgeUrl}/embed`,
      {
        text: "test embedding connection",
      },
      { timeout: 10000 },
    );
    embedSpinner.succeed(`Embeddings OK (${Date.now() - start}ms)`);
  } catch (err) {
    embedSpinner.fail(`Embeddings failed: ${formatError(err)}`);
  }

  // Test LLM
  const llmSpinner = ora("Testing LLM...").start();
  try {
    const model = config.models?.llm?.utility?.model || "qwen3.5:35b";
    const start = Date.now();
    await axios.post(
      `${ollamaUrl}/api/generate`,
      {
        model,
        prompt: 'Say "ok" and nothing else.',
        stream: false,
        options: { num_predict: 10 },
      },
      { timeout: 30000 },
    );
    llmSpinner.succeed(`LLM OK — ${model} (${Date.now() - start}ms)`);
  } catch (err) {
    llmSpinner.fail(`LLM failed: ${formatError(err)}`);
  }

  console.log("");
}
