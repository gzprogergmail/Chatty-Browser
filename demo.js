#!/usr/bin/env node

/**
 * Demo mode - simulates the agent without requiring GitHub authentication
 * This is useful for testing the CLI interface and basic flow
 */

import { MCPServerManager } from './dist/mcp/mcp-server-manager.js';
import { CLIInterface } from './dist/cli/cli-interface.js';
import chalk from 'chalk';

class MockBrowserAgent {
  constructor() {}

  async initialize() {
    console.log(chalk.gray('   Mock agent initialized'));
  }

  async executeCommand(userCommand) {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Simple mock responses
    const responses = {
      'help': 'Available commands: go to [url], search for [query], take screenshot, etc.',
      'test': 'This is a demo mode. Connect real GitHub Copilot for full functionality.',
    };

    // Check for navigation commands
    if (userCommand.toLowerCase().includes('go to') || userCommand.toLowerCase().includes('navigate')) {
      return 'In demo mode, I would navigate to the specified URL using Playwright.';
    }

    if (userCommand.toLowerCase().includes('search')) {
      return 'In demo mode, I would perform a search using Playwright tools.';
    }

    if (userCommand.toLowerCase().includes('screenshot')) {
      return 'In demo mode, I would take a screenshot of the current page.';
    }

    if (userCommand.toLowerCase().includes('click')) {
      return 'In demo mode, I would click on the specified element.';
    }

    return responses[userCommand.toLowerCase()] || 
           'This is demo mode. For full functionality, run `npm start` with GitHub authentication.';
  }
}

async function main() {
  console.log(chalk.bold.blue('\n🤖 Self-Contained Browser Agent (DEMO MODE)\n'));
  console.log(chalk.yellow('⚠️  Running in demo mode - no GitHub authentication required'));
  console.log(chalk.yellow('⚠️  For full functionality, run: npm start\n'));

  try {
    // Create mock agent
    const agent = new MockBrowserAgent();
    await agent.initialize();

    console.log(chalk.green('✓ Demo agent ready\n'));
    console.log(chalk.cyan('🚀 Type commands to see how the CLI works.\n'));
    console.log(chalk.gray('Examples: "go to google.com", "search for AI", "take screenshot"\n'));

    // Start CLI Interface
    const cli = new CLIInterface(agent);
    await cli.start();

  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    process.exit(1);
  }
}

main();
