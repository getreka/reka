import chalk from "chalk";
import ora from "ora";
import { AxiosInstance } from "axios";
import { RekaConfig } from "../config";
import { formatError } from "../api";

export async function indexCommand(
  client: AxiosInstance,
  config: RekaConfig,
  opts: { path?: string; watch?: boolean },
) {
  const indexPath = opts.path || config.project.path;
  const spinner = ora(`Indexing ${indexPath}...`).start();

  try {
    const { data } = await client.post("/api/index", {
      path: indexPath,
      projectName: config.project.name,
    });

    spinner.succeed(`Indexed ${data.filesProcessed || "N/A"} files`);

    if (data.stats) {
      console.log("");
      console.log(`  Chunks:   ${data.stats.chunks || "N/A"}`);
      console.log(`  Symbols:  ${data.stats.symbols || "N/A"}`);
      console.log(`  Duration: ${data.stats.duration || "N/A"}`);
    }
  } catch (err) {
    spinner.fail(`Index failed: ${formatError(err)}`);
    process.exit(1);
  }

  console.log("");
}
