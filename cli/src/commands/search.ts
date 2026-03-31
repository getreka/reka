import chalk from "chalk";
import ora from "ora";
import { AxiosInstance } from "axios";
import { RekaConfig } from "../config";
import { formatError } from "../api";

export async function searchCommand(
  client: AxiosInstance,
  config: RekaConfig,
  query: string,
  opts: { limit?: string; type?: string },
) {
  const limit = parseInt(opts.limit || "5", 10);
  const spinner = ora("Searching...").start();

  try {
    const { data } = await client.post("/api/search", {
      query,
      limit,
      collection: opts.type || "codebase",
    });

    spinner.stop();

    const results = data.results || data;
    if (!results || results.length === 0) {
      console.log(chalk.yellow("\n  No results found.\n"));
      return;
    }

    console.log(chalk.bold(`\n  ${results.length} results for "${query}"\n`));

    for (const [i, r] of results.entries()) {
      const score = r.score
        ? chalk.gray(`(${(r.score * 100).toFixed(0)}%)`)
        : "";
      const filePath = r.metadata?.filePath || r.metadata?.file_path || "";
      const lines = r.metadata?.startLine
        ? `:${r.metadata.startLine}-${r.metadata.endLine || ""}`
        : "";

      console.log(
        `  ${chalk.blue(`${i + 1}.`)} ${chalk.bold(filePath)}${lines} ${score}`,
      );

      // Show snippet (first 3 lines)
      if (r.content || r.text) {
        const text = (r.content || r.text) as string;
        const snippet = text.split("\n").slice(0, 3).join("\n");
        console.log(chalk.gray(`     ${snippet.replace(/\n/g, "\n     ")}`));
      }
      console.log("");
    }
  } catch (err) {
    spinner.fail(`Search failed: ${formatError(err)}`);
    process.exit(1);
  }
}
