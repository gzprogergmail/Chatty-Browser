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
  retrievedMemoryIds: number[];
  memories: MemorySearchResult[];
  matchedQueries: string[];
}

export class BrowserAgent {
  private readonly preflightMemoryLimit = 3;
  private readonly preflightMemoryFinalLimit = 3;
  private readonly preflightMemoryHopTwoQueryLimit = 5;
  private readonly preflightMemoryStopWords = new Set([
    'a', 'an', 'and', 'at', 'click', 'create', 'edit', 'fill', 'find', 'for', 'go', 'in',
    'launch', 'me', 'my', 'navigate', 'of', 'on', 'open', 'please', 'search', 'show', 'start',
    'tell', 'the', 'to', 'use', 'with', 'workflow', 'project', 'task', 'user', 'general', 'site',
  ]);
  private readonly systemPrompt = `You are a helpful AI assistant that controls a web browser using Playwright.
You have access to various browser automation tools through the MCP (Model Context Protocol) server.
You also have long-term memory tools:
- query_memory: Search reusable knowledge from past sessions using short results that support follow-up searches or direct lookup by memory ID.
- deep_search_history: Search archived conversation history directly when normal memory search is not enough. It is slower and noisier, but it can recover older findings that never became durable memory.
- save_memory: Save concise reusable lessons, workflows, preferences, or site knowledge for future sessions.

When the user asks you to do something with the browser, break it down into steps and use the available tools.
Take initiative and try to complete the user's goal end-to-end instead of asking the user for the next step whenever you can reasonably figure it out yourself.
Prefer doing web research in the browser to resolve missing details before asking a follow-up question.
If the user asks to open something, default to opening it in the browser.
If what to open is not fully clear, use the browser to research it, make the best-supported guess from the evidence you find, briefly state the assumption, and then open it.
Only ask the user for clarification when the ambiguity creates a meaningful risk of taking the wrong action or when multiple plausible choices would lead to materially different outcomes.
Before re-learning how a site, workflow, or user preference works, use query_memory to check whether a prior session already discovered something reusable.
query_memory results are intentionally compact. If the first search is only partially helpful, do a follow-up search with refined terms based on the short hits, or read specific memory IDs in full.
query_memory also supports a queries array with up to 5 alternate phrasings, abbreviations, or likely synonyms in one call. Use that when memory lookup is ambiguous or the first wording may miss useful memory.
When searching memory, vary your wording creatively instead of repeating the same terms. Try alternate phrasings, abbreviations, product names, school or district acronyms, workflow synonyms, and shorter subject-focused versions of the request.
For example, if one search is weak, try nearby variants such as full name vs acronym, action phrase vs subject phrase, or corrected spelling.
If a memory search comes back empty, try several alternate phrasings before giving up.
If the user explicitly asks you to search deeper, search further, or search the whole history, explain that you can run a slower deep history search over archived conversation messages and ask whether they want that broader search.
Use deep_search_history only after setting that expectation or when the user clearly asked for the broader, slower search.
Use save_memory after discovering something likely to help future sessions, but save distilled reusable knowledge instead of raw transcripts or one-off details.
If a new discovery overturns an older memory, save the corrected memory and mark the older memory IDs as superseded or invalidated.
The app may prepend a "Current date and time" section before the live user request. Treat it as the authoritative turn date instead of guessing what "today" means.
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

      if (this.shouldPrioritizeDistillation(userCommand, response)) {
        this.memory.requestPriorityDistillation('substantial-assistant-finding');
        return response;
      }
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
    const currentDateTime = this.buildCurrentDateTimeContext();

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
            retrievedMemoryIds: [],
            injectedCount: 0,
          },
        });
        return [
          'Current date and time:',
          currentDateTime,
          '',
          'Live user request:',
          userCommand,
        ].join('\n');
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
          retrievedMemoryIds: lookup.retrievedMemoryIds,
          matchedQueries: lookup.matchedQueries,
          injectedCount: lookup.memories.length,
          memoryIds: lookup.memories.map((memory) => memory.id),
          subjects: lookup.memories.map((memory) => memory.subject),
        },
      });

      return [
        'Current date and time:',
        currentDateTime,
        '',
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
      return [
        'Current date and time:',
        currentDateTime,
        '',
        'Live user request:',
        userCommand,
      ].join('\n');
    }
  }

  private buildCurrentDateTimeContext(now = new Date()): string {
    const parts = new Map(
      new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
        .formatToParts(now)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );

    const weekday = parts.get('weekday') ?? '';
    const month = parts.get('month') ?? '';
    const day = parts.get('day') ?? '';
    const year = parts.get('year') ?? '';
    const hour = parts.get('hour') ?? '';
    const minute = parts.get('minute') ?? '';
    const second = parts.get('second') ?? '';
    const dayPeriod = parts.get('dayPeriod') ?? '';
    const timeZoneName = parts.get('timeZoneName') ?? '';

    return `${weekday}, ${month} ${day}, ${year} ${hour}:${minute}:${second} ${dayPeriod} ${timeZoneName} (${now.toISOString()})`.trim();
  }

  private shouldPrioritizeDistillation(userCommand: string, response: string): boolean {
    const normalizedResponse = response.trim();
    if (!normalizedResponse) {
      return false;
    }

    const hasSourceSignals = /https?:\/\/|sources?\b|official\b/i.test(normalizedResponse);
    const hasDateSignals = /\b\d{4}-\d{2}-\d{2}\b/.test(normalizedResponse) || /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(normalizedResponse);
    const hasListSignals = (normalizedResponse.match(/^\s*[-*]\s+/gm) ?? []).length >= 2;
    const hasNamedEntityDensity = (normalizedResponse.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) ?? []).length >= 2;
    const responseLooksSubstantial = normalizedResponse.length >= 280 || normalizedResponse.split('\n').length >= 6;
    const userAskedForResearch = /\b(find|look up|research|calendar|holiday|holidays|when|which|what|dates?|compare|difference|differences)\b/i.test(userCommand);

    return responseLooksSubstantial && (
      hasSourceSignals
      || hasDateSignals
      || hasListSignals
      || hasNamedEntityDensity
      || userAskedForResearch
    );
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

    const strongDirectCandidates = Array.from(candidates.values()).filter((candidate) => {
      const overlap = this.countMeaningfulOverlap(userCommand, candidate.memory);
      return candidate.hops.has(1) && candidate.score >= 70 && overlap >= 1;
    });
    const anchorTokens = new Set<string>(this.extractMeaningfulTokens(userCommand));
    for (const candidate of strongDirectCandidates.slice(0, 2)) {
      this.extractMemoryTokens(candidate.memory).forEach((token) => anchorTokens.add(token));
    }

    const orderedCandidates = Array.from(candidates.values())
      .filter((candidate) => this.shouldInjectMemoryCandidate(candidate, userCommand, anchorTokens, strongDirectCandidates.length > 0))
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.firstSeenOrder - b.firstSeenOrder;
      })
      .slice(0, this.preflightMemoryFinalLimit);

    if (orderedCandidates.length === 0) {
      return null;
    }

    return {
      hop1Queries,
      hop2Queries,
      linkedMemoryIds,
      retrievedMemoryIds: Array.from(candidates.keys()).sort((a, b) => a - b),
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

  private shouldInjectMemoryCandidate(
    candidate: PreflightMemoryCandidate,
    userCommand: string,
    anchorTokens: Set<string>,
    hasStrongDirectCandidate: boolean,
  ): boolean {
    const requestOverlap = this.countMeaningfulOverlap(userCommand, candidate.memory);
    const anchorOverlap = this.countTokenOverlap(anchorTokens, this.extractMemoryTokens(candidate.memory));

    if (candidate.hops.has(1)) {
      return candidate.score >= 70 && requestOverlap >= 1;
    }

    if (!hasStrongDirectCandidate) {
      return false;
    }

    return candidate.score >= 50 && (requestOverlap >= 1 || anchorOverlap >= 1);
  }

  private countMeaningfulOverlap(userCommand: string, memory: MemorySearchResult): number {
    return this.countTokenOverlap(
      new Set(this.extractMeaningfulTokens(userCommand)),
      this.extractMemoryTokens(memory),
    );
  }

  private countTokenOverlap(left: Set<string>, right: Set<string>): number {
    let overlap = 0;
    for (const token of left) {
      if (right.has(token)) {
        overlap++;
      }
    }
    return overlap;
  }

  private extractMemoryTokens(memory: MemorySearchResult): Set<string> {
    return new Set(this.extractMeaningfulTokens([
      memory.subject,
      memory.summary,
      memory.detailsSnippet,
      ...memory.tags,
    ].filter(Boolean).join(' ')));
  }

  private extractMeaningfulTokens(text: string): string[] {
    return Array.from(new Set(
      (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length >= 2 && !this.preflightMemoryStopWords.has(token)),
    ));
  }
}
