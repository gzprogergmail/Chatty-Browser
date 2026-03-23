#!/usr/bin/env node

import { GitHubAuth } from './auth/github-auth.js';
import { CopilotClient } from './copilot/copilot-client.js';
import { MCPServerManager } from './mcp/mcp-server-manager.js';
import { CLIInterface } from './cli/cli-interface.js';
import { BrowserAgent } from './agent/browser-agent.js';
import chalk from 'chalk';

async function main() {
  console.log(chalk.bold.blue('\n🤖 Self-Contained Browser Agent\n'));

  try {
    // Step 1: GitHub Authentication
    console.log(chalk.cyan('Step 1: Authenticating with GitHub...'));
    const auth = new GitHubAuth();
    const token = await auth.authenticate();
    console.log(chalk.green('✓ GitHub authentication successful\n'));

    // Step 2: Initialize Copilot SDK with gpt-5-mini
    console.log(chalk.cyan('Step 2: Starting Copilot SDK (gpt-5-mini)...'));
    const copilot = new CopilotClient();
    await copilot.initialize('gpt-5-mini', token);
    console.log(chalk.green('✓ Copilot SDK ready with gpt-5-mini\n'));

    // Step 3: Start Playwright MCP Server
    console.log(chalk.cyan('Step 3: Starting Playwright MCP Server...'));
    const mcpServer = new MCPServerManager();
    await mcpServer.start();
    console.log(chalk.green('✓ MCP Server started\n'));

    // Step 4: Launch Browser
    console.log(chalk.cyan('Step 4: Launching Chromium browser...'));
    await mcpServer.launchBrowser();
    console.log(chalk.green('✓ Browser launched\n'));

    // Step 5: Initialize Browser Agent
    const agent = new BrowserAgent(copilot, mcpServer);
    await agent.initialize();

    // Step 6: Start CLI Interface
    console.log(chalk.cyan('\n🚀 Ready! You can now give commands to control the browser.\n'));
    const cli = new CLIInterface(agent);
    await cli.start();

  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
