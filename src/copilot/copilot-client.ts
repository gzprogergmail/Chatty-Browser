import { CopilotClient as SDKClient, CopilotSession, defineTool, approveAll } from '@github/copilot-sdk';
import chalk from 'chalk';

/**
 * Shape of an MCP tool as returned by MCPServerManager.getTools().
 * Matches the SDK's expectation for raw JSON-Schema tool definitions.
 */
export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: any;
}

/**
 * Wrapper around the official @github/copilot-sdk.
 *
 * Key improvements over the previous raw-axios implementation:
 *
 *  - Infinite Sessions: the SDK automatically compacts context before the
 *    window fills, so there is no hard token ceiling and no manual pruning.
 *
 *  - Screenshot context: tool results, including Playwright screenshots, are
 *    stored as-is.  Seeing the page visually significantly improves
 *    browser-control quality.  The old proxy-imposed 64k limit no longer
 *    applies — the SDK communicates through the official Copilot CLI which
 *    uses the model's full 128k window.
 *
 *  - Tool calling: MCP tools are registered once at session creation; the SDK
 *    drives the tool-call / result cycle automatically without a manual loop.
 */
export class CopilotClient {
  private sdkClient: SDKClient | null = null;
  private session: CopilotSession | null = null;
  private model: string = 'gpt-4o';

  // Saved for /new session re-creation
  private savedTools: MCPToolDef[] = [];
  private savedCallTool: ((name: string, args: any) => Promise<any>) | null = null;
  private savedSystemPrompt: string = '';

  // Token usage estimation for the display bar
  private estimatedTokens = 0;
  private compacting = false;
  private readonly MODEL_CONTEXT = 128_000; // GPT-4o native window

  async initialize(model: string = 'gpt-4o', githubToken?: string) {
    this.model = model;
    // Silence Node.js experimental warnings (e.g. node:sqlite) in the SDK's
    // CLI subprocess, which inherits our process environment.
    process.env.NODE_NO_WARNINGS = '1';
    // Pass the GitHub token so the SDK authenticates without needing `gh auth login`.
    this.sdkClient = new SDKClient({ githubToken });
    await this.sdkClient.start();
    console.log(chalk.gray('   Copilot SDK client started'));
  }

  /**
   * Create (or re-create) the conversation session with MCP tools registered.
   * Call this after initialize() and whenever /new is issued.
   */
  async createSession(
    mcpTools: MCPToolDef[],
    callTool: (name: string, args: any) => Promise<any>,
    systemPrompt: string = '',
  ): Promise<void> {
    this.savedTools = mcpTools;
    this.savedCallTool = callTool;
    this.savedSystemPrompt = systemPrompt;

    if (this.session) {
      await this.session.disconnect().catch(() => {});
      this.session = null;
    }

    this.estimatedTokens = 0;
    this.compacting = false;

    // Register MCP tools with the SDK.
    // Screenshot results are kept intact — the model uses them to understand
    // the current state of the browser page, which improves action quality.
    const sdkTools = mcpTools.map(tool =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
        skipPermission: true,
        handler: async (args: unknown) => callTool(tool.name, args),
      }),
    );

    this.session = await this.sdkClient!.createSession({
      model: this.model,
      tools: sdkTools,
      onPermissionRequest: approveAll,
      ...(systemPrompt ? { systemMessage: { mode: 'replace' as const, content: systemPrompt } } : {}),
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
      },
    });

    // Track compaction for the token-usage bar
    this.session.on('session.compaction_start', () => {
      this.compacting = true;
    });
    this.session.on('session.compaction_complete', (event) => {
      this.compacting = false;
      if (event.data.postCompactionTokens != null) {
        this.estimatedTokens = event.data.postCompactionTokens;
      }
    });
  }

  async sendMessage(message: string, timeoutMs = 300_000): Promise<string> {
    if (!this.session) {
      throw new Error('No active session. Call createSession() first.');
    }
    const response = await this.session.sendAndWait({ prompt: message }, timeoutMs);
    const content: string = response?.data?.content ?? '';

    // Running rough token estimate (4 chars ≈ 1 token)
    this.estimatedTokens += Math.ceil((message.length + content.length) / 4);

    return content;
  }

  /** Disconnect and recreate a fresh session (used by /new command). */
  async newSession(): Promise<void> {
    if (this.savedCallTool) {
      await this.createSession(this.savedTools, this.savedCallTool, this.savedSystemPrompt);
    }
  }

  getTokenUsage(): { used: number; max: number; compacting: boolean } {
    return { used: this.estimatedTokens, max: this.MODEL_CONTEXT, compacting: this.compacting };
  }

  async stop(): Promise<void> {
    await this.session?.disconnect().catch(() => {});
    if (this.sdkClient) {
      await this.sdkClient.stop().catch(() => {});
    }
  }
}
