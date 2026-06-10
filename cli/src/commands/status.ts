import chalk from "chalk";
import { AxiosInstance } from "axios";
import { RekaConfig } from "../config";
import { formatError } from "../api";

export async function statusCommand(client: AxiosInstance, config: RekaConfig) {
  console.log(chalk.bold("\n  Reka Status\n"));
  console.log(`  API:     ${config.api.url}`);
  console.log(`  Project: ${config.project.name}`);
  console.log(`  Path:    ${config.project.path}`);
  console.log("");

  // Check API health
  try {
    const { data } = await client.get("/health");
    console.log(`  API:     ${chalk.green("● healthy")}`);
    if (data.cache) {
      console.log(
        `  Cache:   ${chalk.green("● connected")} (${data.cache.hitRate || "N/A"} hit rate)`,
      );
    }
  } catch (err) {
    console.log(
      `  API:     ${chalk.red("● unreachable")} — ${formatError(err)}`,
    );
    return;
  }

  // Check services
  try {
    const { data } = await client.get("/api/project/stats");
    const stats = data.stats || data;
    console.log("");
    console.log(chalk.bold("  Project Stats"));
    if (stats.collections) {
      console.log(`  Collections:  ${stats.collections}`);
    }
    if (stats.totalPoints !== undefined) {
      console.log(`  Vectors:      ${stats.totalPoints.toLocaleString()}`);
    }
    if (stats.memoryCount !== undefined) {
      console.log(`  Memories:     ${stats.memoryCount}`);
    }
  } catch {
    // Stats endpoint may not exist, that's ok
  }

  // Check index status
  try {
    const { data } = await client.get("/api/index/status");
    if (data.status) {
      const s = data.status;
      console.log("");
      console.log(chalk.bold("  Index"));
      console.log(
        `  Status:   ${s.indexing ? chalk.yellow("● indexing") : chalk.green("● idle")}`,
      );
      if (s.totalFiles) console.log(`  Files:    ${s.totalFiles}`);
      if (s.lastIndexed)
        console.log(`  Last run: ${new Date(s.lastIndexed).toLocaleString()}`);
    }
  } catch {
    // Index status may not exist
  }

  console.log("");
}
