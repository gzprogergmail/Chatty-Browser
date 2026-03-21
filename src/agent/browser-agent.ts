import { CopilotClient } from '../copilot/copilot-client.js';
import { MCPServerManager } from '../mcp/mcp-server-manager.js';
import chalk from 'chalk';

export class BrowserAgent {
  private systemPrompt = `You are a helpful AI assistant that controls a web browser using Playwright.
You have access to various browser automation tools through the MCP (Model Context Protocol) server.

When the user asks you to do something with the browser, break it down into steps and use the available tools.
Available actions typically include:
- playwright_navigate(url): Navigate to a URL
- playwright_click(selector): Click an element
- playwright_fill(selector, value): Fill in a form field
- playwright_screenshot(): Take a screenshot
- playwright_evaluate(script): Run JavaScript in the browser
- And more browser automation tools

Always explain what you're doing and provide feedback to the user.
If something goes wrong, explain the error and suggest alternatives.`;

  constructor(
    private copilot: CopilotClient,
    private mcp: MCPServerManager
  ) {}

  async initialize() {
    // Set up the system prompt with available tools
    const tools = this.mcp.getTools();
    console.log(chalk.gray(`   Loaded ${tools.length} browser control tools`));
  }

  async executeCommand(userCommand: string): Promise<string> {
    let result = '';
    let maxIterations = 10; // Prevent infinite loops
    let iteration = 0;

    // Get tools in OpenAI format for the LLM
    const tools = this.mcp.getToolsForLLM();

    // Start with user command
    let currentMessage = `${this.systemPrompt}\n\nUser request: ${userCommand}`;

    while (iteration < maxIterations) {
      iteration++;

      // Ask LLM what to do
      const response = await this.copilot.chatWithTools(currentMessage, tools);

      // Check if LLM wants to call tools
      if (response.toolCalls && response.toolCalls.length > 0) {
        console.log(chalk.gray('\n🔧 Executing actions...'));

        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);

          console.log(chalk.blue(`   → ${toolName}(${JSON.stringify(toolArgs)})`));

          try {
            // Execute the tool via MCP
            const toolResult = await this.mcp.callTool(toolName, toolArgs);
            
            console.log(chalk.green(`   ✓ ${toolName} completed`));

            // Add tool result to conversation
            this.copilot.addToolResult(toolCall.id, toolName, toolResult);

            // Continue with next iteration to let LLM process the result
            currentMessage = 'Continue based on the tool result.';
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(chalk.red(`   ✗ ${toolName} failed: ${errorMsg}`));
            
            this.copilot.addToolResult(toolCall.id, toolName, { error: errorMsg });
            currentMessage = `The tool ${toolName} failed with error: ${errorMsg}. Please try a different approach or explain the issue to the user.`;
          }
        }
      } else {
        // LLM provided a text response (done with actions)
        result = response.content;
        break;
      }
    }

    if (iteration >= maxIterations) {
      result = 'I reached the maximum number of actions. The task may be too complex or I encountered an issue.';
    }

    return result;
  }
}
