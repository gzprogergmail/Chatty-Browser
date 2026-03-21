import { CopilotClient as SDKClient, CopilotSession, defineTool } from '@github/copilot-sdk';
import type { PermissionHandler } from '@github/copilot-sdk';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { toolLogger } from './tool-logger.js';

// ── Confirmation helper ────────────────────────────────────────────────────────

async function confirmAction(message: string): Promise<boolean> {
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    { type: 'confirm', name: 'ok', message, default: false },
  ]);
  return ok;
}

// ── Tool-call display helpers ──────────────────────────────────────────────────

/** Coloured icon + name label for a tool. */
function toolLabel(name: string): string {
  if (name.startsWith('browser_'))                                      return chalk.cyan(`🌐 ${name}`);
  if (['bash', 'write_bash', 'read_bash', 'stop_bash', 'list_bash'].includes(name)) return chalk.magenta(`💻 ${name}`);
  if (['str_replace_editor', 'grep', 'glob'].includes(name))            return chalk.yellow(`📁 ${name}`);
  if (name === 'web_fetch')                                              return chalk.blue(`🔗 ${name}`);
  return chalk.gray(`⚡ ${name}`);
}

/**
 * Single-line JSON representation of tool args.
 * Long string values are truncated to 80 characters to keep the line readable.
 */
function formatArgs(args: unknown): string {
  if (args == null) return '';
  try {
    const trunc = (v: unknown): unknown => {
      if (typeof v === 'string' && v.length > 80)
        return v.slice(0, 80) + ` …(${v.length - 80} more)`;
      if (Array.isArray(v)) return v.map(trunc);
      if (typeof v === 'object' && v !== null)
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, v2]) => [k, trunc(v2)]),
        );
      return v;
    };
    return JSON.stringify(trunc(args));
  } catch {
    return String(args);
  }
}

// ── Permission handler ────────────────────────────────────────────────────────
// Auto-approves everything except disk READ and WRITE, which require explicit
// user confirmation via an inline prompt.

const permissionHandler: PermissionHandler = async (request) => {
  const { kind } = request;
  if (kind === 'read' || kind === 'write') {
    const label = kind === 'write' ? 'WRITE' : 'READ';
    // Surface any extra context the permission request carries (file path, etc.)
    const extra = Object.entries(request)
      .filter(([k]) => k !== 'kind' && k !== 'toolCallId')
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    const ok = await confirmAction(
      `Allow disk ${label} operation?${extra ? `  (${extra})` : ''}`,
    );
    return ok
      ? { kind: 'approved' }
      : { kind: 'denied-interactively-by-user', feedback: 'User denied disk access.' };
  }
  // Everything else (shell, mcp, url, custom-tool) is approved automatically.
  return { kind: 'approved' };
};

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
      onPermissionRequest: permissionHandler,
      ...(systemPrompt ? { systemMessage: { mode: 'replace' as const, content: systemPrompt } } : {}),
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
      },
      hooks: {
        // ── Pre-tool hook: print + log every call, confirm dangerous HTTP ──────
        onPreToolUse: async ({ toolName, toolArgs }) => {
          // 1. Print the tool invocation to the console in real-time.
          process.stdout.write(
            '\n   ' + toolLabel(toolName) + '  ' + chalk.gray(formatArgs(toolArgs)) + '\n',
          );

          // 2. Append a 'call' entry to the rotating JSONL log.
          toolLogger.log({ type: 'call', tool: toolName, args: toolArgs });

          // 3. For web_fetch: ask the user before executing state-changing
          //    HTTP methods (POST, PUT, DELETE, PATCH).
          if (toolName === 'web_fetch') {
            const a = toolArgs as Record<string, unknown>;
            const method = (typeof a?.method === 'string' ? a.method : 'GET').toUpperCase();
            if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
              const url = typeof a?.url === 'string' ? a.url : JSON.stringify(a?.url);
              const ok = await confirmAction(`Allow ${method} request to ${url}?`);
              if (!ok) {
                return {
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: 'User denied HTTP request.',
                };
              }
            }
          }

          return { permissionDecision: 'allow' as const };
        },

        // ── Post-tool hook: log every result ────────────────────────────────
        onPostToolUse: async ({ toolName, toolArgs, toolResult }) => {
          toolLogger.log({ type: 'result', tool: toolName, args: toolArgs, result: toolResult });
        },
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
