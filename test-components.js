// Quick test script to verify basic imports and structure
import { MCPServerManager } from './dist/mcp/mcp-server-manager.js';
import chalk from 'chalk';

console.log(chalk.green('✓ All imports successful'));
console.log(chalk.blue('Testing MCP Server Manager initialization...'));

const mcp = new MCPServerManager();
console.log(chalk.green('✓ MCP Server Manager created'));

console.log(chalk.cyan('\nAll components can be instantiated successfully!'));
console.log(chalk.yellow('\nNote: Full testing requires GitHub authentication and Copilot access.'));
