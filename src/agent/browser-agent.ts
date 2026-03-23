import { CopilotClient } from '../copilot/copilot-client.js';
import type { AvailableModel } from '../copilot/copilot-client.js';
import type { PremiumRequestsUsage } from '../copilot/copilot-client.js';
import type { TokenUsageSnapshot } from '../copilot/copilot-client.js';
import { MemoryManager } from '../memory/memory-store.js';
import type { MemoryManagerOptions } from '../memory/memory-store.js';
import type { MemorySearchResult } from '../memory/memory-store.js';
import type { MemoryOperationEvent } from '../memory/memory-store.js';
import type { MemorySidekickStatus } from '../memory/memory-store.js';
import { MCPServerManager } from '../mcp/mcp-server-manager.js';
import { memoryOperationLogger } from '../copilot/tool-logger.js';
import chalk from 'chalk';

interface BrowserAgentOptions {
  memoryManager?: MemoryManager;
  memoryOptions?: Omit<MemoryManagerOptions, 'distiller'>;
}

interface PreflightMemoryCandidate {
  memory: MemorySearchResult;
  score: number;
  hops: Set<number>;
  matchedQueries: Set<string>;
  matchedTags: Set<string>;
  firstSeenOrder: number;
}

interface PreflightMemoryLookup {
  hop1Queries: string[];
  hop2Queries: string[];
  linkedMemoryIds: number[];
  memories: MemorySearchResult[];
  matchedQueries: string[];
}

export class BrowserAgent {
  private readonly preflightMemoryLimit = 3;
  private readonly preflightMemoryFinalLimit = 5;
  private readonly preflightMemoryHopTwoQueryLimit = 5;
  private readonly preflightMemoryStopWords = new Set([
    'a', 'an', 'and', 'at', 'click', 'create', 'edit', 'fill', 'find', 'for', 'go', 'in',
    'launch', 'me', 'my', 'navigate', 'of', 'on', 'open', 'please', 'search', 'show', 'start',
    'tell', 'the', 'to', 'use', 'with',
  ]);
  private readonly systemPrompt = `You are a helpful AI assistant that controls a web browser using Playwright.
You have access to various browser automation tools through the MCP (Model Context Protocol) server.
You also have long-term memory tools:
- query_memory: Search reusable knowledge from past sessions using short results that support follow-up searches or direct lookup by memory ID.
- save_memory: Save concise reusable lessons, workflows, preferences, or site knowledge for future sessions.

When the user asks you to do something with the browser, break it down into steps and use the available tools.
Take initiative and try to complete the user's goal end-to-end instead of asking the user for the next step whenever you can reasonably figure it out yourself.
Prefer doing web research in the browser to resolve missing details before asking a follow-up question.
If the user asks to open something, default to opening it in the browser.
If what to open is not fully clear, use the browser to research it, make the best-supported guess from the evidence you find, briefly state the assumption, and then open it.
Only ask the user for clarification when the ambiguity creates a meaningful risk of taking the wrong action or when multiple plausible choices would lead to materially different outcomes.
Before re-learning how a site, workflow, or user preference works, use query_memory to check whether a prior session already discovered something reusable.
query_memory results are intentionally compact. If the first search is only partially helpful, do a follow-up search with refined terms based on the short hits, or read specific memory IDs in full.
Use save_memory after discovering something likely to help future sessions, but save distilled reusable knowledge instead of raw transcripts or one-off details.
If a new discovery overturns an older memory, save the corrected memory and mark the older memory IDs as superseded or invalidated.
The app may prepend a "Relevant memory context" section before the live user request. Treat it as retrieved long-term memory: use it when helpful, but still verify anything time-sensitive or page-state-specific against the current browser state.
Available actions typically include:
- playwright_navigate(url): Navigate to a URL
- playwright_click(selector): Click an element
- playwright_fill(selector, value): Fill in a form field
- playwright_screenshot(): Take a screenshot
- playwright_evaluate(script): Run JavaScript in the browser
- And more browser automation tools

Always explain what you're doing and provide feedback to the user.
If something goes wrong, explain the error and suggest alternatives.`;
  private readonly memory: MemoryManager;

  constructor(
    private copilot: CopilotClient,
    private mcp: MCPServerManager,
    options: BrowserAgentOptions = {},
  ) {
    this.memory = options.memoryManager ?? new MemoryManager({
      ...options.memoryOptions,
      distiller: typeof this.copilot.distillConversationMemory === 'function'
        ? (request) => this.copilot.distillConversationMemory(request)
        : undefined,
    });

    this.memory.on('operation', (event: MemoryOperationEvent) => {
      memoryOperationLogger.log({
        category: event.category,
        action: event.action,
        payload: event.payload,
      });
    });
  }

  async initialize() {
    const browserTools = this.mcp.getTools();
    const memoryTools = this.memory.getTools();
    const tools = [...browserTools, ...memoryTools];
    console.log(chalk.gray(`   Loaded ${browserTools.length} browser control tools and ${memoryTools.length} memory tools`));

    // Register MCP tools with the official Copilot SDK session.
    // Tool results — including Playwright screenshots — are kept in context
    // as-is.  Seeing the page visually helps the model make better decisions.
    // Infinite Sessions handles context compaction automatically so there is
    // no need to strip images or manually prune history.
    await this.copilot.createSession(
      tools,
      (name, args) => this.callTool(name, args),
      this.systemPrompt,
    );
  }

  async executeCommand(userCommand: string): Promise<string> {
    this.memory.recordConversationMessage({
      role: 'user',
      content: userCommand,
      source: 'user-command',
    });

    // The official SDK drives the entire agentic loop (tool calls → results
    // → follow-up turns) automatically.  We just send the user's request and
    // receive the final narrative response.
    const prompt = this.buildPromptWithMemoryContext(userCommand);
    const response = await this.copilot.sendMessage(prompt);

    if (response.trim()) {
      this.memory.recordConversationMessage({
        role: 'assistant',
        content: response,
        source: 'assistant-response',
      });
    }

    this.memory.maybeScheduleDistillation();
    return response;
  }

  didStreamLastTurn(): boolean {
    return this.copilot.didStreamLastTurn();
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

  getTurnTimeoutMs(): number {
    return this.copilot.getTurnTimeoutMs();
  }

  setTurnTimeoutMs(timeoutMs: number): number {
    return this.copilot.setTurnTimeoutMs(timeoutMs);
  }

  /** Approximate token usage for the current conversation. */
  getTokenUsage(): TokenUsageSnapshot {
    return this.copilot.getTokenUsage();
  }

  async getPremiumRequestsUsage(): Promise<PremiumRequestsUsage> {
    return this.copilot.getPremiumRequestsUsage();
  }

  getMemorySidekickStatus(): MemorySidekickStatus {
    return this.memory.getSidekickStatus();
  }

  onMemorySidekickStatusChange(listener: (status: MemorySidekickStatus) => void): () => void {
    this.memory.on('status', listener);
    return () => {
      this.memory.off('status', listener);
    };
  }

  async flushMemorySidekick(): Promise<void> {
    await this.memory.flushSidekick();
  }

  private async callTool(name: string, args: unknown): Promise<unknown> {
    if (this.memory.hasTool(name)) {
      return this.memory.callTool(name, args);
    }

    return this.mcp.callTool(name, args);
  }

  private buildPromptWithMemoryContext(userCommand: string): string {
    try {
      const lookup = this.findRelevantMemoriesForPrompt(userCommand);

      if (!lookup) {
        memoryOperationLogger.log({
          category: 'memory',
          action: 'prompt.prefetch',
          payload: {
            query: userCommand,
            hop1Queries: this.buildPreflightMemoryQueries(userCommand),
            hop2Queries: [],
            linkedMemoryIds: [],
            injectedCount: 0,
          },
        });
        return userCommand;
      }

      const context = lookup.memories
        .map((memory, index) => {
          const meta = `${memory.scope}, ${memory.status}, confidence ${memory.confidence.toFixed(2)}`;
          const detail = memory.detailsSnippet ? ` Details: ${memory.detailsSnippet}` : '';
          return `${index + 1}. [Memory ${memory.id}] ${memory.subject} (${meta})\n   Summary: ${memory.summary}${detail}`;
        })
        .join('\n');

      memoryOperationLogger.log({
        category: 'memory',
        action: 'prompt.prefetch',
        payload: {
          query: userCommand,
          hop1Queries: lookup.hop1Queries,
          hop2Queries: lookup.hop2Queries,
          linkedMemoryIds: lookup.linkedMemoryIds,
          matchedQueries: lookup.matchedQueries,
          injectedCount: lookup.memories.length,
          memoryIds: lookup.memories.map((memory) => memory.id),
          subjects: lookup.memories.map((memory) => memory.subject),
        },
      });

      return [
        'Relevant memory context:',
        context,
        '',
        'Live user request:',
        userCommand,
      ].join('\n');
    } catch (error) {
      memoryOperationLogger.log({
        category: 'memory',
        action: 'prompt.prefetch_failed',
        payload: {
          query: userCommand,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return userCommand;
    }
  }

  private findRelevantMemoriesForPrompt(userCommand: string): PreflightMemoryLookup | null {
    const hop1Queries = this.buildPreflightMemoryQueries(userCommand);
    const candidates = new Map<number, PreflightMemoryCandidate>();
    let seenOrder = 0;

    this.collectPreflightCandidates(hop1Queries, 1, candidates, () => seenOrder++);
    if (candidates.size === 0) {
      return null;
    }

    const hop2Queries = this.buildHopTwoQueries(
      Array.from(candidates.values()).map((candidate) => candidate.memory),
      new Set(hop1Queries),
    );
    this.collectPreflightCandidates(hop2Queries, 2, candidates, () => seenOrder++);
    const linkedMemoryIds = this.buildLinkedMemoryIds(
      Array.from(candidates.values()).map((candidate) => candidate.memory),
      new Set(candidates.keys()),
    );
    this.collectLinkedPreflightCandidates(linkedMemoryIds, candidates, () => seenOrder++);

    const orderedCandidates = Array.from(candidates.values())
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.firstSeenOrder - b.firstSeenOrder;
      })
      .slice(0, this.preflightMemoryFinalLimit);

    return {
      hop1Queries,
      hop2Queries,
      linkedMemoryIds,
      memories: orderedCandidates.map((candidate) => candidate.memory),
      matchedQueries: Array.from(new Set(
        orderedCandidates.flatMap((candidate) => Array.from(candidate.matchedQueries)),
      )),
    };
  }

  private buildPreflightMemoryQueries(userCommand: string): string[] {
    const normalized = userCommand.trim();
    const reduced = (normalized.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => !this.preflightMemoryStopWords.has(token))
      .join(' ')
      .trim();

    return Array.from(new Set([normalized, reduced].filter(Boolean)));
  }

  private collectPreflightCandidates(
    queries: string[],
    hop: 1 | 2,
    candidates: Map<number, PreflightMemoryCandidate>,
    nextSeenOrder: () => number,
  ): void {
    for (const query of queries) {
      const results = this.memory.queryMemory({
        query,
        limit: this.preflightMemoryLimit,
      });

      results.memories.forEach((memory, index) => {
        const existing = candidates.get(memory.id);
        const weight = (hop === 1 ? 100 : 45) - index * 5 + memory.confidence * 10 + (memory.status === 'active' ? 5 : 0);

        if (existing) {
          existing.score += weight + 8;
          existing.hops.add(hop);
          existing.matchedQueries.add(query);
          memory.tags.forEach((tag) => existing.matchedTags.add(tag));
          return;
        }

        candidates.set(memory.id, {
          memory,
          score: weight,
          hops: new Set([hop]),
          matchedQueries: new Set([query]),
          matchedTags: new Set(memory.tags),
          firstSeenOrder: nextSeenOrder(),
        });
      });
    }
  }

  private buildHopTwoQueries(memories: MemorySearchResult[], usedQueries: Set<string>): string[] {
    const queries: string[] = [];

    for (const memory of memories) {
      const subject = memory.subject.trim().toLowerCase();
      if (subject && !usedQueries.has(subject)) {
        queries.push(subject);
      }

      for (const tag of memory.tags) {
        const normalizedTag = tag.trim().toLowerCase();
        if (!normalizedTag || usedQueries.has(normalizedTag) || this.preflightMemoryStopWords.has(normalizedTag)) {
          continue;
        }
        queries.push(normalizedTag);
      }
    }

    return Array.from(new Set(queries)).slice(0, this.preflightMemoryHopTwoQueryLimit);
  }

  private buildLinkedMemoryIds(memories: MemorySearchResult[], seenMemoryIds: Set<number>): number[] {
    const linkedIds: number[] = [];

    for (const memory of memories) {
      for (const relatedMemoryId of memory.relatedMemoryIds) {
        if (seenMemoryIds.has(relatedMemoryId)) continue;
        linkedIds.push(relatedMemoryId);
      }
    }

    return Array.from(new Set(linkedIds)).slice(0, this.preflightMemoryHopTwoQueryLimit);
  }

  private collectLinkedPreflightCandidates(
    memoryIds: number[],
    candidates: Map<number, PreflightMemoryCandidate>,
    nextSeenOrder: () => number,
  ): void {
    if (memoryIds.length === 0) return;

    const results = this.memory.queryMemory({
      memoryIds,
      includeFullDetails: false,
    });

    results.memories.forEach((memory, index) => {
      const existing = candidates.get(memory.id);
      const weight = 58 - index * 4 + memory.confidence * 10 + (memory.status === 'active' ? 5 : 0);

      if (existing) {
        existing.score += weight + 8;
        existing.hops.add(2);
        existing.matchedQueries.add(`linked:${memory.id}`);
        memory.tags.forEach((tag) => existing.matchedTags.add(tag));
        return;
      }

      candidates.set(memory.id, {
        memory,
        score: weight,
        hops: new Set([2]),
        matchedQueries: new Set([`linked:${memory.id}`]),
        matchedTags: new Set(memory.tags),
        firstSeenOrder: nextSeenOrder(),
      });
    });
  }
}
