import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const TEMPLATE = `# Reka Configuration
# Docs: https://github.com/reka-dev/reka

api:
  url: http://localhost:3100
  # key: your-api-key-here

project:
  name: {{PROJECT_NAME}}
  path: {{PROJECT_PATH}}

# Models (optional — defaults to local Ollama + BGE-M3)
# models:
#   embeddings:
#     provider: bge-m3        # bge-m3 | ollama | openai
#     url: http://localhost:8080
#     dimensions: 1024
#
#   llm:
#     utility:
#       provider: ollama
#       model: qwen3.5:35b
#     complex:
#       provider: anthropic
#       model: claude-sonnet-4-6
`;

export async function initCommand(opts: { name?: string; path?: string; force?: boolean }) {
  const projectPath = opts.path || process.cwd();
  const projectName = opts.name || path.basename(projectPath);
  const configPath = path.join(projectPath, 'reka.config.yaml');

  if (fs.existsSync(configPath) && !opts.force) {
    console.log(chalk.yellow(`\n  reka.config.yaml already exists. Use --force to overwrite.\n`));
    return;
  }

  const content = TEMPLATE
    .replace('{{PROJECT_NAME}}', projectName)
    .replace('{{PROJECT_PATH}}', projectPath);

  fs.writeFileSync(configPath, content, 'utf-8');

  console.log(chalk.green(`\n  ✓ Created ${configPath}`));
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Edit ${chalk.bold('reka.config.yaml')} to set your API key`);
  console.log(`    2. Run ${chalk.bold('reka index')} to index your codebase`);
  console.log(`    3. Run ${chalk.bold('reka search "your query"')} to search`);
  console.log('');
}
