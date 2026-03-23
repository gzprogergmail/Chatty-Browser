import { CopilotClient } from '../copilot/copilot-client.js';
import type { AvailableModel } from '../copilot/copilot-client.js';
import type { PremiumRequestsUsage } from '../copilot/copilot-client.js';
import type { TokenUsageSnapshot } from '../copilot/copilot-client.js';
import { MCPServerManager } from '../mcp/mcp-server-manager.js';
import chalk from 'chalk';

export class BrowserAgent {
  private readonly systemPrompt = `You are a helpful AI assistant that controls a web browser using Playwright.
You have access to various browser automation tools through the MCP (Model Context Protocol) server.

When the user asks you to do something with the browser, break it down into steps and use the available tools.
Take initiative and try to complete the user's goal end-to-end instead of asking the user for the next step whenever you can reasonably figure it out yourself.
Prefer doing web research in the browser to resolve missing details before asking a follow-up question.
If the user asks to open something, default to opening it in the browser.
If what to open is not fully clear, use the browser to research it, make the best-supported guess from the evidence you find, briefly state the assumption, and then open it.
Only ask the user for clarification when the ambiguity creates a meaningful risk of taking the wrong action or when multiple plausible choices would lead to materially different outcomes.
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

  async getAvailableModels(): Promise<AvailableModel[]> {
    return this.copilot.getAvailableModels();
  }

  async setModel(modelId: string): Promise<AvailableModel> {
    return this.copilot.setModel(modelId);
  }

  /** Approximate token usage for the current conversation. */
  getTokenUsage(): TokenUsageSnapshot {
    return this.copilot.getTokenUsage();
  }

  async getPremiumRequestsUsage(): Promise<PremiumRequestsUsage> {
    return this.copilot.getPremiumRequestsUsage();
  }
}
