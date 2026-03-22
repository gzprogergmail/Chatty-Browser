import { CopilotClient } from '../copilot/copilot-client.js';
import type { ModelPresetId, ModelPresetStatus } from '../copilot/copilot-client.js';
import { MCPServerManager } from '../mcp/mcp-server-manager.js';
import chalk from 'chalk';

export class BrowserAgent {
  private readonly systemPrompt = `You are a helpful AI assistant that controls a web browser using Playwright.
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
    private mcp: MCPServerManager,
  ) {}

  async initialize() {
    const tools = this.mcp.getTools();
    console.log(chalk.gray(`   Loaded ${tools.length} browser control tools`));

    // Register MCP tools with the official Copilot SDK session.
    // Tool results — including Playwright screenshots — are kept in context
    // as-is.  Seeing the page visually helps the model make better decisions.
    // Infinite Sessions handles context compaction automatically so there is
    // no need to strip images or manually prune history.
    await this.copilot.createSession(
      tools,
      (name, args) => this.mcp.callTool(name, args),
      this.systemPrompt,
    );
  }

  async executeCommand(userCommand: string): Promise<string> {
    // The official SDK drives the entire agentic loop (tool calls → results
    // → follow-up turns) automatically.  We just send the user's request and
    // receive the final narrative response.
    return this.copilot.sendMessage(userCommand);
  }

  /** Start a fresh session (used by /new command). */
  async newSession(): Promise<void> {
    return this.copilot.newSession();
  }

  async getModelPresetStatuses(): Promise<ModelPresetStatus[]> {
    return this.copilot.getModelPresetStatuses();
  }

  async setModelPreset(presetId: ModelPresetId): Promise<ModelPresetStatus> {
    return this.copilot.setModelPreset(presetId);
  }

  /** Approximate token usage for the current conversation. */
  getTokenUsage(): { used: number; max: number; compacting: boolean } {
    return this.copilot.getTokenUsage();
  }
}
