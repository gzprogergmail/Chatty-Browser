/**
 * Live test - sends a command to verify the system works
 */

import { GitHubAuth } from './dist/auth/github-auth.js';
import { CopilotClient } from './dist/copilot/copilot-client.js';
import { MCPServerManager } from './dist/mcp/mcp-server-manager.js';
import { BrowserAgent } from './dist/agent/browser-agent.js';
import chalk from 'chalk';

async function testCommand() {
  console.log(chalk.bold.blue('\n🧪 Live Command Test\n'));

  try {
    // Step 1: Authenticate
    console.log(chalk.cyan('Authenticating...'));
    const auth = new GitHubAuth();
    const token = await auth.authenticate();
    console.log(chalk.green('✓ Authenticated\n'));

    // Step 2: Initialize Copilot
    console.log(chalk.cyan('Connecting to Copilot...'));
    const copilot = new CopilotClient();
    await copilot.initialize('gpt-5-mini', token);
    console.log(chalk.green('✓ Copilot connected\n'));

    // Step 3: Start MCP Server
    console.log(chalk.cyan('Starting MCP Server...'));
    const mcpServer = new MCPServerManager();
    await mcpServer.start();
    console.log(chalk.green(`✓ MCP Server started with ${mcpServer.getTools().length} tools\n`));

    // Step 4: Launch Browser
    console.log(chalk.cyan('Launching browser...'));
    await mcpServer.launchBrowser();
    console.log(chalk.green('✓ Browser launched\n'));

    // Step 5: Create Agent
    const agent = new BrowserAgent(copilot, mcpServer);
    await agent.initialize();

    // Step 6: Test a simple command
    console.log(chalk.bold.cyan('\n📤 Testing command: "go to example.com"\n'));
    const response = await agent.executeCommand('go to example.com');
    console.log(chalk.green('\n✓ Command executed successfully!'));
    console.log(chalk.gray('\nAgent response:'));
    console.log(response);

    // Cleanup
    console.log(chalk.cyan('\n\nCleaning up...'));
    await mcpServer.close();
    console.log(chalk.green('✓ Test complete\n'));

    process.exit(0);
  } catch (error) {
    console.error(chalk.red('\n❌ Test failed:'), error.message);
    console.error(error);
    process.exit(1);
  }
}

testCommand();
