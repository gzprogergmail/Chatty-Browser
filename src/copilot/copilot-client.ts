import { CopilotClient as SDKClient, CopilotSession, defineTool } from '@github/copilot-sdk';
import type { PermissionHandler } from '@github/copilot-sdk';
import type { ModelInfo } from '@github/copilot-sdk';
import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';
import { llmPayloadLogger, toolLogger } from './tool-logger.js';

const LOG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../logs',
);

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

function summarizeText(value: string, max = 160): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return singleLine.slice(0, max) + ` …(${singleLine.length - max} more)`;
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

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AvailableModel {
  id: string;
  label: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  warning?: string;
}

export interface TokenUsageSnapshot {
  model: string;
  used: number;
  max: number;
  compacting: boolean;
}

export interface PremiumRequestsUsage {
  quotaName: string;
  entitlementRequests: number;
  usedRequests: number;
  remainingRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
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
  private model: string = 'gpt-5-mini';
  private reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined = undefined;
  private telemetryFilePath: string | null = null;
  private turnTimeoutMs = 300_000;

  // Saved for /new session re-creation
  private savedTools: MCPToolDef[] = [];
  private savedCallTool: ((name: string, args: any) => Promise<any>) | null = null;
  private savedSystemPrompt: string = '';

  // Token usage from SDK session.usage_info events
  private sdkCurrentTokens = 0;
  private sdkTokenLimit = 128_000; // fallback until first usage_info event
  private compacting = false;
  private sdkMessagesLength = 0;

  async initialize(
    model: string = 'gpt-5-mini',
    githubToken?: string,
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh',
  ) {
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    // Silence Node.js experimental warnings (e.g. node:sqlite) in the SDK's
    // CLI subprocess, which inherits our process environment.
    process.env.NODE_NO_WARNINGS = '1';
    this.telemetryFilePath = this.createTelemetryFilePath();
    // Pass the GitHub token so the SDK authenticates without needing `gh auth login`.
    this.sdkClient = new SDKClient({
      githubToken,
      telemetry: {
        exporterType: 'file',
        filePath: this.telemetryFilePath,
        captureContent: true,
        sourceName: 'chatty-browser',
      },
    });
    await this.sdkClient.start();
    console.log(chalk.gray('   Copilot SDK client started'));
    console.log(chalk.gray(`   Telemetry trace file: ${this.telemetryFilePath}`));
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

    this.sdkCurrentTokens = 0;
    this.sdkTokenLimit = 128_000;
    this.compacting = false;
    this.sdkMessagesLength = 0;

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
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      tools: sdkTools,
      availableTools: [...mcpTools.map(t => t.name), 'web_fetch'],
      onPermissionRequest: permissionHandler,
      onEvent: (event) => {
        if (event.type === 'user.message') {
          process.stdout.write(
            chalk.gray(`   📨 Sent to LLM: ${summarizeText(event.data.content)}`) + '\n',
          );

          llmPayloadLogger.log({
            direction: 'request',
            kind: event.type,
            payload: {
              sessionId: this.session?.sessionId,
              model: this.model,
              reasoningEffort: this.reasoningEffort,
              ...event.data,
            },
          });
        }

        if (event.type === 'assistant.message') {
          const summary = event.data.toolRequests?.length
            ? `${summarizeText(event.data.content || '(tool planning)')} [${event.data.toolRequests.length} tool request${event.data.toolRequests.length === 1 ? '' : 's'}]`
            : summarizeText(event.data.content || '(empty response)');
          process.stdout.write(
            chalk.gray(`   📩 LLM response received: ${summary}`) + '\n',
          );

          llmPayloadLogger.log({
            direction: 'response',
            kind: event.type,
            payload: {
              sessionId: this.session?.sessionId,
              model: this.model,
              reasoningEffort: this.reasoningEffort,
              ...event.data,
            },
          });
        }
      },
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
          process.stdout.write(this.formatTokenUsageLine('Context before tool'));
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
          process.stdout.write(this.formatTokenUsageLine(`Context after ${toolName}`));
        },
      },
    });

    llmPayloadLogger.log({
      direction: 'request',
      kind: 'session.create',
      payload: {
        sessionId: this.session.sessionId,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        availableTools: [...mcpTools.map(t => t.name), 'web_fetch'],
        systemPrompt,
      },
    });

    // Track token usage and compaction via SDK events
    this.session.on('session.usage_info', (event) => {
      this.sdkCurrentTokens = event.data.currentTokens;
      this.sdkTokenLimit = event.data.tokenLimit;
      this.sdkMessagesLength = event.data.messagesLength;
    });
    this.session.on('session.compaction_start', () => {
      this.compacting = true;
    });
    this.session.on('session.compaction_complete', () => {
      this.compacting = false;
    });
  }

  async sendMessage(message: string, timeoutMs = this.turnTimeoutMs): Promise<string> {
    if (!this.session) {
      throw new Error('No active session. Call createSession() first.');
    }
    process.stdout.write(
      chalk.gray(`   🧠 Queueing prompt for ${this.model}${this.reasoningEffort ? ` (${this.reasoningEffort})` : ''}`) + '\n',
    );
    const response = await this.session.sendAndWait({ prompt: message }, timeoutMs);
    const content: string = response?.data?.content ?? '';
    process.stdout.write(chalk.gray('   ✅ Turn complete') + '\n');
    return content;
  }

  getTurnTimeoutMs(): number {
    return this.turnTimeoutMs;
  }

  setTurnTimeoutMs(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      throw new Error('Timeout must be at least 1000 ms.');
    }

    this.turnTimeoutMs = Math.round(timeoutMs);
    return this.turnTimeoutMs;
  }

  /** Disconnect and recreate a fresh session (used by /new command). */
  async newSession(): Promise<void> {
    if (this.savedCallTool) {
      await this.createSession(this.savedTools, this.savedCallTool, this.savedSystemPrompt);
    }
  }

  async getAvailableModels(): Promise<AvailableModel[]> {
    const models = await this.sdkClient!.listModels();
    return models
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((model) => this.toAvailableModel(model));
  }

  async setModel(modelId: string): Promise<AvailableModel> {
    const models = await this.getAvailableModels();
    const selected = models.find(candidate => candidate.model === modelId);

    if (!selected) {
      throw new Error(`${modelId} is not available in the current Copilot account.`);
    }

    this.model = selected.model;
    this.reasoningEffort = selected.reasoningEffort;

    if (this.session) {
      await this.session.setModel(
        this.model,
        this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : undefined,
      );
    }

    llmPayloadLogger.log({
      direction: 'request',
      kind: 'session.set_model',
      payload: {
        sessionId: this.session?.sessionId,
        modelId: selected.id,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        warning: selected.warning,
      },
    });

    return selected;
  }

  getTokenUsage(): TokenUsageSnapshot {
    return {
      model: this.getActiveModelDisplay(),
      used: this.sdkCurrentTokens,
      max: this.sdkTokenLimit,
      compacting: this.compacting,
    };
  }

  async getPremiumRequestsUsage(): Promise<PremiumRequestsUsage> {
    const quota = await this.sdkClient!.rpc.account.getQuota();
    const entries = Object.entries(quota.quotaSnapshots);
    const premiumEntry =
      entries.find(([name]) => name === 'premium_interactions') ??
      entries.find(([name]) => /premium/i.test(name));

    if (!premiumEntry) {
      throw new Error('Copilot did not return a premium request quota snapshot for this account.');
    }

    const [quotaName, snapshot] = premiumEntry;
    return {
      quotaName,
      entitlementRequests: snapshot.entitlementRequests,
      usedRequests: snapshot.usedRequests,
      remainingRequests: Math.max(snapshot.entitlementRequests - snapshot.usedRequests, 0),
      remainingPercentage: snapshot.remainingPercentage,
      overage: snapshot.overage,
      overageAllowedWithExhaustedQuota: snapshot.overageAllowedWithExhaustedQuota,
      resetDate: snapshot.resetDate,
    };
  }

  private formatTokenUsageLine(label: string): string {
    const used = this.sdkCurrentTokens;
    const max = this.sdkTokenLimit || 1;
    const ratio = used / max;
    const pct = (ratio * 100).toFixed(1);
    const colour = ratio > 0.85 ? chalk.red : ratio > 0.60 ? chalk.yellow : chalk.gray;
    const compactingTag = this.compacting ? chalk.cyan(' [compacting]') : '';
    const messages = this.sdkMessagesLength > 0 ? `, ${this.sdkMessagesLength} msgs` : '';
    return colour(`   ${label} [${this.getActiveModelDisplay()}]: ~${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%${messages})`) + compactingTag + '\n';
  }

  private createTelemetryFilePath(): string {
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    return path.join(LOG_DIR, `copilot-otel-${ts}.jsonl`);
  }

  private toAvailableModel(model: ModelInfo): AvailableModel {
    const supportsReasoningEffort = model.capabilities.supports.reasoningEffort;
    const defaultReasoning = this.getPreferredReasoningEffort(model);
    return {
      id: model.id,
      label: this.buildModelLabel(model, defaultReasoning),
      model: model.id,
      reasoningEffort: defaultReasoning,
      supportsReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      warning: this.getModelWarning(model, defaultReasoning),
    };
  }

  private getPreferredReasoningEffort(model: ModelInfo): ReasoningEffort | undefined {
    if (!model.capabilities.supports.reasoningEffort) return undefined;
    if (model.supportedReasoningEfforts?.includes('medium')) return 'medium';
    return model.defaultReasoningEffort;
  }

  private buildModelLabel(model: ModelInfo, reasoningEffort?: ReasoningEffort): string {
    return reasoningEffort ? `${model.name} (${reasoningEffort})` : model.name;
  }

  private getModelWarning(model: ModelInfo, reasoningEffort?: ReasoningEffort): string | undefined {
    if (/haiku/i.test(model.name) && !reasoningEffort) {
      return `${model.name} does not advertise reasoning-effort support in Copilot, so no reasoning level is applied.`;
    }
    return undefined;
  }

  private getActiveModelDisplay(): string {
    return this.reasoningEffort ? `${this.model} (${this.reasoningEffort})` : this.model;
  }

  async stop(): Promise<void> {
    await this.session?.disconnect().catch(() => {});
    if (this.sdkClient) {
      await this.sdkClient.stop().catch(() => {});
    }
  }
}
