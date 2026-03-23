import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export interface MemoryToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type MemoryScope = 'site' | 'workflow' | 'user' | 'project' | 'task' | 'general';
export type MemoryStatus = 'active' | 'superseded' | 'invalidated' | 'needs_recheck';
export type ConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export interface SaveMemoryArgs {
  scope?: MemoryScope;
  subject: string;
  summary: string;
  details?: string;
  tags?: string[];
  relatedMemoryIds?: number[];
  confidence?: number;
  source?: string;
  sourceSessionId?: string;
  lastVerifiedAt?: string;
  status?: MemoryStatus;
  supersedesMemoryIds?: number[];
  invalidatesMemoryIds?: number[];
  invalidationReason?: string;
}

export interface QueryMemoryArgs {
  query?: string;
  queries?: string[];
  scope?: MemoryScope;
  subject?: string;
  tags?: string[];
  limit?: number;
  includeFullDetails?: boolean;
  memoryIds?: number[];
  includeInactive?: boolean;
  status?: MemoryStatus | MemoryStatus[];
}

export interface DeepSearchHistoryArgs {
  query?: string;
  queries?: string[];
  role?: ConversationRole;
  limit?: number;
  includeFullContent?: boolean;
  messageIds?: number[];
}

export interface MemorySearchResult {
  id: number;
  scope: string;
  subject: string;
  summary: string;
  details?: string;
  detailsSnippet?: string;
  tags: string[];
  confidence: number;
  source?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastVerifiedAt?: string;
  relatedMemoryIds: number[];
  status: MemoryStatus;
  resolvedByMemoryId?: number;
  resolutionNote?: string;
  supersedesMemoryIds: number[];
  invalidatesMemoryIds: number[];
  matchReasons: string[];
}

export interface ConversationHistorySearchResult {
  id: number;
  role: ConversationRole;
  content?: string;
  contentSnippet: string;
  tokenEstimate: number;
  createdAt: string;
  sessionId?: string;
  source?: string;
  matchReasons: string[];
}

export interface SaveMemoryResult {
  status: 'created' | 'updated';
  memoryId: number;
  scope: string;
  subject: string;
  summary: string;
  tags: string[];
  confidence: number;
  relatedMemoryIds: number[];
  memoryStatus: MemoryStatus;
  supersedesMemoryIds: number[];
  invalidatesMemoryIds: number[];
  dbPath: string;
}

export interface QueryMemoryResult {
  mode: 'search' | 'read';
  count: number;
  query?: string;
  attemptedQueries?: string[];
  filters?: {
    scope?: string;
    subject?: string;
    tags: string[];
    includeFullDetails: boolean;
    limit: number;
    statuses?: MemoryStatus[];
  };
  summary?: string;
  memories: MemorySearchResult[];
}

export interface DeepSearchHistoryResult {
  mode: 'history-search' | 'history-read';
  count: number;
  query?: string;
  attemptedQueries?: string[];
  filters?: {
    role?: ConversationRole;
    includeFullContent: boolean;
    limit: number;
  };
  summary?: string;
  messages: ConversationHistorySearchResult[];
}

export interface ConversationMessageInput {
  role: ConversationRole;
  content: string;
  tokenEstimate?: number;
  sessionId?: string;
  source?: string;
}

export interface ArchivedConversationMessage {
  id: number;
  role: ConversationRole;
  content: string;
  tokenEstimate: number;
  createdAt: string;
  sessionId?: string;
  source?: string;
}

export interface MemoryDistillationRequest {
  messages: ArchivedConversationMessage[];
  memorySnapshot: MemorySearchResult[];
  pendingTokenEstimate: number;
  distillationThresholdTokens: number;
}

export interface MemoryDistillationResult {
  summary?: string;
  memories?: SaveMemoryArgs[];
}

export type MemoryDistiller = (request: MemoryDistillationRequest) => Promise<MemoryDistillationResult>;
export type SidekickState = 'disabled' | 'idle' | 'running' | 'pending' | 'error';

export interface MemorySidekickStatus {
  state: SidekickState;
  pendingTokenEstimate: number;
  distillationThresholdTokens: number;
  lastRunAt?: string;
  lastSummary?: string;
  lastSavedCount: number;
  lastError?: string;
  rerunQueued: boolean;
}

export type MemoryOperationCategory = 'conversation' | 'tool' | 'status' | 'distillation' | 'memory';

export interface MemoryOperationEvent {
  ts: string;
  category: MemoryOperationCategory;
  action: string;
  payload: Record<string, unknown>;
}

export interface MemoryManagerOptions {
  dbPath?: string;
  distillationThresholdTokens?: number;
  distiller?: MemoryDistiller;
  memorySnapshotLimit?: number;
}

interface MemoryRow {
  id: number;
  scope: string;
  subject: string;
  summary: string;
  details: string;
  tags_json: string;
  tags_text: string;
  confidence: number;
  source: string | null;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_verified_at: string | null;
  status: MemoryStatus;
  resolved_by_memory_id: number | null;
  resolution_note: string | null;
  supersedes_json: string;
  invalidates_json: string;
}

interface RankedMemory {
  row: MemoryRow;
  hasFtsMatch: boolean;
  ftsRank: number;
  matchReasons: Set<string>;
}

interface RankedConversationMessage {
  message: ConversationHistorySearchResult;
  score: number;
}

const MEMORY_SCOPES: MemoryScope[] = ['site', 'workflow', 'user', 'project', 'task', 'general'];
const MEMORY_STATUSES: MemoryStatus[] = ['active', 'superseded', 'invalidated', 'needs_recheck'];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'agent-memory.sqlite');
const LAST_DISTILLED_MESSAGE_ID_KEY = 'last_distilled_message_id';

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath = DEFAULT_DB_PATH) {
    process.env.NODE_NO_WARNINGS ??= '1';
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initialize();
  }

  get databasePath(): string {
    return this.dbPath;
  }

  getTools(): MemoryToolDef[] {
    return [
      {
        name: 'save_memory',
        description: 'Store concise reusable knowledge for future sessions. Save durable lessons, corrections, preferences, workflows, or site knowledge, not raw transcripts.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: MEMORY_SCOPES,
              description: 'Memory scope such as site, workflow, user, project, task, or general.',
            },
            subject: {
              type: 'string',
              description: 'Short subject such as canva, github billing, invoice workflow, or user preference.',
            },
            summary: {
              type: 'string',
              description: 'One-sentence reusable takeaway.',
            },
            details: {
              type: 'string',
              description: 'Optional longer detail with steps, caveats, or verification hints.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional short tags to help future retrieval.',
            },
            relatedMemoryIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Optional related memory IDs that should travel with this memory during retrieval.',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'How trustworthy the memory is from 0.0 to 1.0.',
            },
            source: {
              type: 'string',
              description: 'Optional source description such as live page observation or user instruction.',
            },
            sourceSessionId: {
              type: 'string',
              description: 'Optional session identifier for traceability.',
            },
            lastVerifiedAt: {
              type: 'string',
              description: 'Optional ISO 8601 timestamp when this knowledge was last verified.',
            },
            status: {
              type: 'string',
              enum: MEMORY_STATUSES,
              description: 'Optional explicit status. Defaults to active.',
            },
            supersedesMemoryIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Older memory IDs this new memory supersedes.',
            },
            invalidatesMemoryIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Older memory IDs this new memory invalidates.',
            },
            invalidationReason: {
              type: 'string',
              description: 'Optional note explaining why older memories were superseded or invalidated.',
            },
          },
          required: ['subject', 'summary'],
          additionalProperties: false,
        },
      },
      {
        name: 'query_memory',
        description: 'Search long-term memory with structured filters and full-text search. Default search returns active memories; includeInactive or explicit status filters can surface older superseded knowledge.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language search query. Use this first for broad lookup and follow-up refinement.',
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 5,
              description: 'Optional alternative search phrasings. Use up to 5 variants when the first wording may miss useful memory.',
            },
            scope: {
              type: 'string',
              enum: MEMORY_SCOPES,
              description: 'Optional scope filter such as site or workflow.',
            },
            subject: {
              type: 'string',
              description: 'Optional subject filter for an app, site, or workflow.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags that should appear in the memory.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIMIT,
              description: 'How many memory hits to return for a search.',
            },
            includeFullDetails: {
              type: 'boolean',
              description: 'When true, include full details in search results instead of short snippets.',
            },
            memoryIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Optional explicit IDs to read in full after a short search result suggests a useful record.',
            },
            includeInactive: {
              type: 'boolean',
              description: 'When true, include superseded, invalidated, and needs_recheck memories too.',
            },
            status: {
              anyOf: [
                { type: 'string', enum: MEMORY_STATUSES },
                {
                  type: 'array',
                  items: { type: 'string', enum: MEMORY_STATUSES },
                },
              ],
              description: 'Optional explicit status filter. Defaults to active.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'deep_search_history',
        description: 'Search archived conversation history directly. This is slower and noisier than query_memory, but it can recover older findings that never made it into durable memory.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language query for archived conversation history.',
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 5,
              description: 'Optional alternate phrasings to try across archived conversation history.',
            },
            role: {
              type: 'string',
              enum: ['user', 'assistant', 'tool', 'system'],
              description: 'Optional role filter to search only user, assistant, tool, or system messages.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIMIT,
              description: 'How many archived message hits to return.',
            },
            includeFullContent: {
              type: 'boolean',
              description: 'When true, include the full archived message content instead of just snippets.',
            },
            messageIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Optional explicit archived message IDs to load directly.',
            },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  hasTool(name: string): boolean {
    return this.getTools().some(tool => tool.name === name);
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case 'save_memory':
        return this.saveMemory(args as SaveMemoryArgs);
      case 'query_memory':
        return this.queryMemory(args as QueryMemoryArgs);
      case 'deep_search_history':
        return this.deepSearchHistory(args as DeepSearchHistoryArgs);
      default:
        throw new Error(`Unknown memory tool: ${name}`);
    }
  }

  close(): void {
    if (typeof (this.db as { close?: () => void }).close === 'function') {
      (this.db as { close: () => void }).close();
    }
  }

  saveMemory(args: SaveMemoryArgs): SaveMemoryResult {
    const now = new Date().toISOString();
    const scope = this.normalizeScope(args.scope) ?? 'general';
    const subject = this.requireText(args.subject, 'subject');
    const summary = this.requireText(args.summary, 'summary');
    const details = this.normalizeOptionalText(args.details) ?? '';
    const tags = this.normalizeTags(args.tags);
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(' ');
    const relatedMemoryIds = this.normalizeMemoryIds(args.relatedMemoryIds);
    const confidence = this.normalizeConfidence(args.confidence);
    const source = this.normalizeOptionalText(args.source) ?? null;
    const sourceSessionId = this.normalizeOptionalText(args.sourceSessionId) ?? null;
    const lastVerifiedAt = this.normalizeOptionalText(args.lastVerifiedAt) ?? null;
    const memoryStatus = this.normalizeStatus(args.status) ?? 'active';
    const supersedesMemoryIds = this.normalizeMemoryIds(args.supersedesMemoryIds);
    const invalidatesMemoryIds = this.normalizeMemoryIds(args.invalidatesMemoryIds);
    const invalidationReason = this.normalizeOptionalText(args.invalidationReason) ?? null;

    const existing = this.db.prepare(
      `SELECT id FROM memories
       WHERE scope = ? AND lower(subject) = lower(?) AND lower(summary) = lower(?)
       LIMIT 1`,
    ).get(scope, subject, summary) as { id?: number } | undefined;

    let memoryId: number;
    let action: 'created' | 'updated';

    if (existing?.id) {
      this.db.prepare(
        `UPDATE memories
         SET details = ?, tags_json = ?, tags_text = ?, confidence = ?, source = ?, source_session_id = ?,
             updated_at = ?, last_verified_at = COALESCE(?, last_verified_at), status = ?, supersedes_json = ?,
             invalidates_json = ?
         WHERE id = ?`,
      ).run(
        details,
        tagsJson,
        tagsText,
        confidence,
        source,
        sourceSessionId,
        now,
        lastVerifiedAt,
        memoryStatus,
        JSON.stringify(supersedesMemoryIds),
        JSON.stringify(invalidatesMemoryIds),
        existing.id,
      );
      memoryId = existing.id;
      action = 'updated';
    } else {
      const result = this.db.prepare(
        `INSERT INTO memories (
          scope, subject, summary, details, tags_json, tags_text, confidence,
          source, source_session_id, created_at, updated_at, last_verified_at,
          status, supersedes_json, invalidates_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        scope,
        subject,
        summary,
        details,
        tagsJson,
        tagsText,
        confidence,
        source,
        sourceSessionId,
        now,
        now,
        lastVerifiedAt,
        memoryStatus,
        JSON.stringify(supersedesMemoryIds),
        JSON.stringify(invalidatesMemoryIds),
      );
      memoryId = Number(result.lastInsertRowid);
      action = 'created';
    }

    this.resolveConflictingMemories(memoryId, supersedesMemoryIds, invalidatesMemoryIds, invalidationReason, now);
    this.replaceRelatedMemoryEdges(memoryId, relatedMemoryIds, now);
    this.replaceFtsEntry(memoryId);

    return {
      status: action,
      memoryId,
      scope,
      subject,
      summary,
      tags,
      confidence,
      relatedMemoryIds,
      memoryStatus,
      supersedesMemoryIds,
      invalidatesMemoryIds,
      dbPath: this.dbPath,
    };
  }

  queryMemory(args: QueryMemoryArgs): QueryMemoryResult {
    const memoryIds = this.normalizeMemoryIds(args.memoryIds);
    const includeFullDetails = args.includeFullDetails === true || memoryIds.length > 0;
    const statuses = this.normalizeStatuses(args.status, args.includeInactive === true, memoryIds.length > 0);

    if (memoryIds.length > 0) {
      const memories = this.readMemories(memoryIds, true);
      return {
        mode: 'read',
        count: memories.length,
        memories,
      };
    }

    const limit = this.normalizeLimit(args.limit);
    const attemptedQueries = this.normalizeQueryList(args.query, args.queries);
    const query = attemptedQueries[0];
    const scope = this.normalizeScope(args.scope, false);
    const subject = this.normalizeOptionalText(args.subject);
    const tags = this.normalizeTags(args.tags);
    const memories = attemptedQueries.length <= 1
      ? this.searchMemories({
          query,
          scope,
          subject,
          tags,
          limit,
          includeFullDetails,
          statuses,
        })
      : this.searchMemoriesAcrossQueries({
          queries: attemptedQueries,
          scope,
          subject,
          tags,
          limit,
          includeFullDetails,
          statuses,
        });

    return {
      mode: 'search',
      count: memories.length,
      query,
      attemptedQueries,
      filters: {
        scope,
        subject,
        tags,
        includeFullDetails,
        limit,
        statuses,
      },
      summary: memories.length > 0
        ? attemptedQueries.length > 1
          ? `Found ${memories.length} memory hit${memories.length === 1 ? '' : 's'} across ${attemptedQueries.length} search variants for iterative follow-up search or direct reuse.`
          : `Found ${memories.length} memory hit${memories.length === 1 ? '' : 's'} for iterative follow-up search or direct reuse.`
        : attemptedQueries.length > 1
          ? `No matching memories found across ${attemptedQueries.length} search variants.`
          : 'No matching memories found.',
      memories,
    };
  }

  deepSearchHistory(args: DeepSearchHistoryArgs): DeepSearchHistoryResult {
    const includeFullContent = args.includeFullContent === true;
    const limit = this.normalizeLimit(args.limit);
    const messageIds = this.normalizeMemoryIds(args.messageIds);
    const role = args.role ? this.normalizeConversationRole(args.role) : undefined;

    if (messageIds.length > 0) {
      const messages = this.readConversationMessagesById(messageIds, includeFullContent);
      return {
        mode: 'history-read',
        count: messages.length,
        filters: {
          ...(role ? { role } : {}),
          includeFullContent,
          limit,
        },
        summary: messages.length > 0
          ? `Loaded ${messages.length} archived conversation message${messages.length === 1 ? '' : 's'} by ID.`
          : 'No archived conversation messages matched those IDs.',
        messages,
      };
    }

    const attemptedQueries = this.normalizeQueryList(args.query, args.queries);
    const messages = attemptedQueries.length > 0
      ? this.searchConversationHistoryAcrossQueries({
          queries: attemptedQueries,
          role,
          limit,
          includeFullContent,
        })
      : [];

    return {
      mode: 'history-search',
      count: messages.length,
      query: attemptedQueries[0],
      attemptedQueries,
      filters: {
        ...(role ? { role } : {}),
        includeFullContent,
        limit,
      },
      summary: messages.length > 0
        ? attemptedQueries.length > 1
          ? `Found ${messages.length} archived conversation hit${messages.length === 1 ? '' : 's'} across ${attemptedQueries.length} search variants.`
          : `Found ${messages.length} archived conversation hit${messages.length === 1 ? '' : 's'} in the deeper history search.`
        : attemptedQueries.length > 1
          ? `No archived conversation hits matched across ${attemptedQueries.length} search variants.`
          : 'No archived conversation hits matched the deeper history search.',
      messages,
    };
  }

  appendConversationMessage(input: ConversationMessageInput): ArchivedConversationMessage {
    const content = this.requireText(input.content, 'content');
    const role = this.normalizeConversationRole(input.role);
    const now = new Date().toISOString();
    const tokenEstimate = this.normalizeTokenEstimate(input.tokenEstimate ?? Math.max(1, Math.ceil(content.length / 4)));
    const sessionId = this.normalizeOptionalText(input.sessionId);
    const source = this.normalizeOptionalText(input.source);
    const result = this.db.prepare(
      `INSERT INTO conversation_messages (role, content, token_estimate, created_at, session_id, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      role,
      content,
      tokenEstimate,
      now,
      sessionId ?? null,
      source ?? null,
    );
    const messageId = Number(result.lastInsertRowid);
    this.db.prepare(
      `INSERT INTO conversation_messages_fts (rowid, role, content, source)
       VALUES (?, ?, ?, ?)`,
    ).run(
      messageId,
      role,
      content,
      source ?? '',
    );
    return {
      id: messageId,
      role,
      content,
      tokenEstimate,
      createdAt: now,
      sessionId,
      source,
    };
  }

  getConversationMessagesSince(lastMessageId: number): ArchivedConversationMessage[] {
    const rows = this.db.prepare(
      `SELECT id, role, content, token_estimate, created_at, session_id, source
       FROM conversation_messages
       WHERE id > ?
       ORDER BY id ASC`,
    ).all(lastMessageId) as Array<{
      id: number;
      role: ConversationRole;
      content: string;
      token_estimate: number;
      created_at: string;
      session_id: string | null;
      source: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      tokenEstimate: row.token_estimate,
      createdAt: row.created_at,
      sessionId: row.session_id ?? undefined,
      source: row.source ?? undefined,
    }));
  }

  getPendingConversationTokenEstimate(lastMessageId: number): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS total
       FROM conversation_messages
       WHERE id > ?`,
    ).get(lastMessageId) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }

  getRelevantActiveMemoriesForText(text: string, limit = DEFAULT_LIMIT): MemorySearchResult[] {
    return this.searchMemories({
      query: text,
      limit,
      includeFullDetails: true,
      statuses: ['active'],
      tags: [],
    });
  }

  getRuntimeState(key: string): string | undefined {
    const row = this.db.prepare(
      'SELECT value FROM memory_runtime_state WHERE key = ? LIMIT 1',
    ).get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setRuntimeState(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO memory_runtime_state (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        tags_text TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        last_verified_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        resolved_by_memory_id INTEGER,
        resolution_note TEXT,
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        invalidates_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
      CREATE INDEX IF NOT EXISTS idx_memories_last_verified_at ON memories(last_verified_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        subject,
        summary,
        details,
        tags,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        session_id TEXT,
        source TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_id ON conversation_messages(id);
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_role ON conversation_messages(role);

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
        role,
        content,
        source,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS memory_runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_edges (
        memory_id_a INTEGER NOT NULL,
        memory_id_b INTEGER NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id_a, memory_id_b, relation),
        FOREIGN KEY (memory_id_a) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id_b) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_edges_a ON memory_edges(memory_id_a, relation);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_b ON memory_edges(memory_id_b, relation);
    `);

    this.migrateMemoriesTable();
    this.rebuildConversationMessageFtsIfNeeded();
  }

  private migrateMemoriesTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => String(column.name)));

    this.ensureColumn(names, 'status', `ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    this.ensureColumn(names, 'resolved_by_memory_id', 'ALTER TABLE memories ADD COLUMN resolved_by_memory_id INTEGER');
    this.ensureColumn(names, 'resolution_note', 'ALTER TABLE memories ADD COLUMN resolution_note TEXT');
    this.ensureColumn(names, 'supersedes_json', `ALTER TABLE memories ADD COLUMN supersedes_json TEXT NOT NULL DEFAULT '[]'`);
    this.ensureColumn(names, 'invalidates_json', `ALTER TABLE memories ADD COLUMN invalidates_json TEXT NOT NULL DEFAULT '[]'`);

    this.db.exec(`
      UPDATE memories SET status = 'active' WHERE status IS NULL OR trim(status) = '';
      UPDATE memories SET supersedes_json = '[]' WHERE supersedes_json IS NULL OR trim(supersedes_json) = '';
      UPDATE memories SET invalidates_json = '[]' WHERE invalidates_json IS NULL OR trim(invalidates_json) = '';
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    `);
  }

  private ensureColumn(columns: Set<string>, name: string, sql: string): void {
    if (columns.has(name)) return;
    this.db.exec(sql);
    columns.add(name);
  }

  private resolveConflictingMemories(
    memoryId: number,
    supersedesMemoryIds: number[],
    invalidatesMemoryIds: number[],
    invalidationReason: string | null,
    now: string,
  ): void {
    const supersededIds = supersedesMemoryIds.filter(id => id !== memoryId);
    const invalidatedIds = invalidatesMemoryIds.filter(id => id !== memoryId);

    if (supersededIds.length > 0) {
      const placeholders = supersededIds.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE memories
         SET status = 'superseded', resolved_by_memory_id = ?, resolution_note = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
      ).run(
        memoryId,
        invalidationReason ?? `Superseded by memory ${memoryId}`,
        now,
        ...supersededIds,
      );
    }

    if (invalidatedIds.length > 0) {
      const placeholders = invalidatedIds.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE memories
         SET status = 'invalidated', resolved_by_memory_id = ?, resolution_note = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
      ).run(
        memoryId,
        invalidationReason ?? `Invalidated by memory ${memoryId}`,
        now,
        ...invalidatedIds,
      );
    }
  }

  private replaceRelatedMemoryEdges(memoryId: number, relatedMemoryIds: number[], now: string): void {
    this.db.prepare(
      `DELETE FROM memory_edges
       WHERE relation = 'related' AND (memory_id_a = ? OR memory_id_b = ?)`,
    ).run(memoryId, memoryId);

    for (const relatedId of relatedMemoryIds.filter((id) => id !== memoryId)) {
      const memoryIdA = Math.min(memoryId, relatedId);
      const memoryIdB = Math.max(memoryId, relatedId);
      if (memoryIdA === memoryIdB) continue;

      this.db.prepare(
        `INSERT INTO memory_edges (memory_id_a, memory_id_b, relation, created_at, updated_at)
         VALUES (?, ?, 'related', ?, ?)
         ON CONFLICT(memory_id_a, memory_id_b, relation)
         DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(memoryIdA, memoryIdB, now, now);
    }
  }

  private searchMemories(options: {
    query?: string;
    scope?: string;
    subject?: string;
    tags: string[];
    limit: number;
    includeFullDetails: boolean;
    statuses?: MemoryStatus[];
  }): MemorySearchResult[] {
    const ranked = new Map<number, RankedMemory>();
    const fetchLimit = Math.max(options.limit * 3, 10);
    const filterParts: string[] = [];
    const filterParams: Array<string> = [];

    if (options.scope) {
      filterParts.push('m.scope = ?');
      filterParams.push(options.scope);
    }

    if (options.subject) {
      filterParts.push('lower(m.subject) LIKE ?');
      filterParams.push(`%${options.subject.toLowerCase()}%`);
    }

    if (options.statuses?.length) {
      filterParts.push(`m.status IN (${options.statuses.map(() => '?').join(', ')})`);
      filterParams.push(...options.statuses);
    }

    for (const tag of options.tags) {
      filterParts.push('lower(m.tags_text) LIKE ?');
      filterParams.push(`%${tag.toLowerCase()}%`);
    }

    const filterSql = filterParts.length > 0 ? ` AND ${filterParts.join(' AND ')}` : '';
    const tokens = this.extractSearchTokens(options.query);
    const ftsQuery = tokens.length > 0 ? tokens.map(token => `${token}*`).join(' OR ') : null;

    if (ftsQuery) {
      const ftsRows = this.db.prepare(
        `SELECT
           m.*,
           bm25(memories_fts, 4.0, 8.0, 2.0, 1.0) AS fts_rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?${filterSql}
         ORDER BY fts_rank ASC, m.confidence DESC, COALESCE(m.last_verified_at, m.updated_at) DESC
         LIMIT ?`,
      ).all(ftsQuery, ...filterParams, fetchLimit) as Array<MemoryRow & { fts_rank: number }>;

      for (const row of ftsRows) {
        this.mergeRankedRow(
          ranked,
          row,
          true,
          Number.isFinite(row.fts_rank) ? row.fts_rank : Number.MAX_SAFE_INTEGER,
          'fts',
        );
      }
    }

    if (tokens.length > 0) {
      const likeClauses = tokens
        .map(() => '(lower(m.subject) LIKE ? OR lower(m.summary) LIKE ? OR lower(m.details) LIKE ? OR lower(m.tags_text) LIKE ?)')
        .join(' OR ');
      const likeParams = tokens.flatMap((token) => {
        const pattern = `%${token.toLowerCase()}%`;
        return [pattern, pattern, pattern, pattern];
      });

      const likeRows = this.db.prepare(
        `SELECT m.* FROM memories m
         WHERE (${likeClauses})${filterSql}
         ORDER BY m.confidence DESC, COALESCE(m.last_verified_at, m.updated_at) DESC
         LIMIT ?`,
      ).all(...likeParams, ...filterParams, fetchLimit) as MemoryRow[];

      for (const row of likeRows) {
        this.mergeRankedRow(ranked, row, false, Number.MAX_SAFE_INTEGER, 'text');
      }
    }

    if (tokens.length === 0) {
      const recentRows = this.db.prepare(
        `SELECT m.* FROM memories m
         WHERE 1 = 1${filterSql}
         ORDER BY COALESCE(m.last_used_at, m.last_verified_at, m.updated_at, m.created_at) DESC, m.confidence DESC
         LIMIT ?`,
      ).all(...filterParams, fetchLimit) as MemoryRow[];

      for (const row of recentRows) {
        this.mergeRankedRow(ranked, row, false, Number.MAX_SAFE_INTEGER, 'recent');
      }
    }

    const ordered = Array.from(ranked.values())
      .sort((a, b) => {
        const statusPriority = this.getStatusPriority(a.row.status) - this.getStatusPriority(b.row.status);
        if (statusPriority !== 0) return statusPriority;
        if (a.hasFtsMatch !== b.hasFtsMatch) return a.hasFtsMatch ? -1 : 1;
        if (a.ftsRank !== b.ftsRank) return a.ftsRank - b.ftsRank;
        if (a.row.confidence !== b.row.confidence) return b.row.confidence - a.row.confidence;
        return this.compareIsoDateDesc(
          a.row.last_verified_at ?? a.row.updated_at,
          b.row.last_verified_at ?? b.row.updated_at,
        );
      })
      .slice(0, options.limit);

    this.touchMemories(ordered.map(item => item.row.id));
    const relatedIds = this.loadRelatedMemoryIds(ordered.map((item) => item.row.id));
    return ordered.map((item) => this.toSearchResult(
      item.row,
      item.matchReasons,
      options.includeFullDetails,
      relatedIds.get(item.row.id) ?? [],
    ));
  }

  private searchMemoriesAcrossQueries(options: {
    queries: string[];
    scope?: string;
    subject?: string;
    tags: string[];
    limit: number;
    includeFullDetails: boolean;
    statuses?: MemoryStatus[];
  }): MemorySearchResult[] {
    const merged = new Map<number, { memory: MemorySearchResult; score: number; firstSeenOrder: number }>();
    let seenOrder = 0;

    for (const query of options.queries) {
      const results = this.searchMemories({
        query,
        scope: options.scope,
        subject: options.subject,
        tags: options.tags,
        limit: options.limit,
        includeFullDetails: options.includeFullDetails,
        statuses: options.statuses,
      });

      results.forEach((memory, index) => {
        const existing = merged.get(memory.id);
        const weight = 100 - index * 8 + memory.confidence * 10 + (memory.status === 'active' ? 5 : 0);

        if (existing) {
          existing.score += weight + 10;
          existing.memory.matchReasons = Array.from(new Set([...existing.memory.matchReasons, ...memory.matchReasons]));
          return;
        }

        merged.set(memory.id, {
          memory,
          score: weight,
          firstSeenOrder: seenOrder++,
        });
      });
    }

    return Array.from(merged.values())
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.firstSeenOrder - b.firstSeenOrder;
      })
      .slice(0, options.limit)
      .map((entry) => entry.memory);
  }

  private readMemories(memoryIds: number[], includeFullDetails: boolean): MemorySearchResult[] {
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
    ).all(...memoryIds) as MemoryRow[];

    this.touchMemories(rows.map(row => row.id));
    const relatedIds = this.loadRelatedMemoryIds(rows.map((row) => row.id));
    return rows.map((row) => this.toSearchResult(row, new Set(['read']), includeFullDetails, relatedIds.get(row.id) ?? []));
  }

  private toSearchResult(
    row: MemoryRow,
    matchReasons: Set<string>,
    includeFullDetails: boolean,
    relatedMemoryIds: number[],
  ): MemorySearchResult {
    return {
      id: row.id,
      scope: row.scope,
      subject: row.subject,
      summary: row.summary,
      details: includeFullDetails ? row.details : undefined,
      detailsSnippet: includeFullDetails ? undefined : this.createSnippet(row.details),
      tags: this.parseTags(row.tags_json),
      confidence: row.confidence,
      source: row.source ?? undefined,
      sourceSessionId: row.source_session_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
      lastVerifiedAt: row.last_verified_at ?? undefined,
      relatedMemoryIds,
      status: row.status,
      resolvedByMemoryId: row.resolved_by_memory_id ?? undefined,
      resolutionNote: row.resolution_note ?? undefined,
      supersedesMemoryIds: this.parseIds(row.supersedes_json),
      invalidatesMemoryIds: this.parseIds(row.invalidates_json),
      matchReasons: Array.from(matchReasons),
    };
  }

  private loadRelatedMemoryIds(memoryIds: number[]): Map<number, number[]> {
    const uniqueIds = Array.from(new Set(memoryIds.filter((id) => Number.isInteger(id) && id > 0)));
    const relatedByMemoryId = new Map<number, number[]>();

    for (const memoryId of uniqueIds) {
      relatedByMemoryId.set(memoryId, []);
    }

    if (uniqueIds.length === 0) {
      return relatedByMemoryId;
    }

    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT memory_id_a, memory_id_b
       FROM memory_edges
       WHERE relation = 'related'
         AND (memory_id_a IN (${placeholders}) OR memory_id_b IN (${placeholders}))`,
    ).all(...uniqueIds, ...uniqueIds) as Array<{ memory_id_a: number; memory_id_b: number }>;

    for (const row of rows) {
      if (relatedByMemoryId.has(row.memory_id_a)) {
        relatedByMemoryId.get(row.memory_id_a)!.push(row.memory_id_b);
      }
      if (relatedByMemoryId.has(row.memory_id_b)) {
        relatedByMemoryId.get(row.memory_id_b)!.push(row.memory_id_a);
      }
    }

    for (const [memoryId, relatedIds] of relatedByMemoryId.entries()) {
      relatedByMemoryId.set(memoryId, Array.from(new Set(relatedIds)).sort((a, b) => a - b));
    }

    return relatedByMemoryId;
  }

  private replaceFtsEntry(memoryId: number): void {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as MemoryRow | undefined;
    if (!row) return;

    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(memoryId);
    this.db.prepare(
      `INSERT INTO memories_fts (rowid, subject, summary, details, tags)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(memoryId, row.subject, row.summary, row.details, row.tags_text);
  }

  private mergeRankedRow(
    ranked: Map<number, RankedMemory>,
    row: MemoryRow,
    hasFtsMatch: boolean,
    ftsRank: number,
    reason: string,
  ): void {
    const existing = ranked.get(row.id);
    if (!existing) {
      ranked.set(row.id, {
        row,
        hasFtsMatch,
        ftsRank,
        matchReasons: new Set([reason]),
      });
      return;
    }

    existing.hasFtsMatch = existing.hasFtsMatch || hasFtsMatch;
    existing.ftsRank = Math.min(existing.ftsRank, ftsRank);
    existing.matchReasons.add(reason);
  }

  private touchMemories(memoryIds: number[]): void {
    if (memoryIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = memoryIds.map(() => '?').join(', ');
    this.db.prepare(
      `UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`,
    ).run(now, ...memoryIds);
  }

  private normalizeScope(scope?: string, fallbackToGeneral = true): string | undefined {
    if (!scope) return fallbackToGeneral ? 'general' : undefined;
    const normalized = scope.trim().toLowerCase();
    if (!MEMORY_SCOPES.includes(normalized as MemoryScope)) {
      throw new Error(`Invalid memory scope: ${scope}`);
    }
    return normalized;
  }

  private normalizeStatus(status?: string): MemoryStatus | undefined {
    if (!status) return undefined;
    const normalized = status.trim().toLowerCase();
    if (!MEMORY_STATUSES.includes(normalized as MemoryStatus)) {
      throw new Error(`Invalid memory status: ${status}`);
    }
    return normalized as MemoryStatus;
  }

  private normalizeStatuses(
    status: QueryMemoryArgs['status'],
    includeInactive: boolean,
    readingById = false,
  ): MemoryStatus[] | undefined {
    if (readingById) return undefined;
    if (status) {
      const raw = Array.isArray(status) ? status : [status];
      return Array.from(new Set(raw.map(item => this.normalizeStatus(item)!)));
    }
    if (includeInactive) return undefined;
    return ['active'];
  }

  private normalizeOptionalText(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private requireText(value: string | undefined, field: string): string {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error(`${field} is required`);
    }
    return trimmed;
  }

  private normalizeTags(tags?: string[]): string[] {
    return Array.from(new Set(
      (tags ?? [])
        .map(tag => tag.trim().toLowerCase())
        .filter(Boolean),
    )).slice(0, 12);
  }

  private normalizeConfidence(value?: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 0.7;
    }
    return Math.min(1, Math.max(0, Number(value)));
  }

  private normalizeLimit(limit?: number): number {
    if (!Number.isInteger(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
  }

  private normalizeQueryList(query?: string, queries?: string[]): string[] {
    return Array.from(new Set(
      [query, ...(queries ?? [])]
        .map((value) => this.normalizeOptionalText(value))
        .filter((value): value is string => Boolean(value)),
    )).slice(0, 5);
  }

  private normalizeMemoryIds(memoryIds?: number[]): number[] {
    return Array.from(new Set(
      (memoryIds ?? [])
        .filter(id => Number.isInteger(id) && id > 0)
        .map(id => Number(id)),
    )).slice(0, MAX_LIMIT);
  }

  private normalizeConversationRole(role: string): ConversationRole {
    const normalized = role.trim().toLowerCase();
    if (!['user', 'assistant', 'tool', 'system'].includes(normalized)) {
      throw new Error(`Invalid conversation role: ${role}`);
    }
    return normalized as ConversationRole;
  }

  private normalizeTokenEstimate(value: number): number {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      return 1;
    }
    return Math.max(1, Math.round(normalized));
  }

  private extractSearchTokens(query?: string): string[] {
    if (!query) return [];
    return Array.from(new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9]{2,}/g) ?? [],
    )).slice(0, 8);
  }

  private createSnippet(value: string, maxLength = 180): string | undefined {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (!singleLine) return undefined;
    if (singleLine.length <= maxLength) return singleLine;
    return `${singleLine.slice(0, maxLength)}…`;
  }

  private rebuildConversationMessageFtsIfNeeded(): void {
    this.db.exec(`
      INSERT INTO conversation_messages_fts (rowid, role, content, source)
      SELECT message.id, message.role, message.content, COALESCE(message.source, '')
      FROM conversation_messages message
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversation_messages_fts fts
        WHERE fts.rowid = message.id
      );
    `);
  }

  private searchConversationHistoryAcrossQueries(options: {
    queries: string[];
    role?: ConversationRole;
    limit: number;
    includeFullContent: boolean;
  }): ConversationHistorySearchResult[] {
    const merged = new Map<number, { message: ConversationHistorySearchResult; score: number; firstSeenOrder: number }>();
    let seenOrder = 0;

    for (const query of options.queries) {
      const results = this.searchConversationHistory({
        query,
        role: options.role,
        limit: options.limit,
        includeFullContent: options.includeFullContent,
      });

      results.forEach((message, index) => {
        const existing = merged.get(message.id);
        const weight = 100 - index * 10 + (message.role === 'assistant' ? 8 : 0);

        if (existing) {
          existing.score += weight + 10;
          existing.message.matchReasons = Array.from(new Set([...existing.message.matchReasons, ...message.matchReasons]));
          return;
        }

        merged.set(message.id, {
          message,
          score: weight,
          firstSeenOrder: seenOrder++,
        });
      });
    }

    return Array.from(merged.values())
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.firstSeenOrder - b.firstSeenOrder;
      })
      .slice(0, options.limit)
      .map((entry) => entry.message);
  }

  private searchConversationHistory(options: {
    query: string;
    role?: ConversationRole;
    limit: number;
    includeFullContent: boolean;
  }): ConversationHistorySearchResult[] {
    const query = this.normalizeOptionalText(options.query);
    if (!query) return [];

    const tokens = this.extractSearchTokens(query);
    const fetchLimit = Math.max(options.limit * 6, 20);
    const loweredQuery = query.toLowerCase();
    const filterParts: string[] = [];
    const filterParams: Array<string | number> = [];

    if (options.role) {
      filterParts.push('m.role = ?');
      filterParams.push(options.role);
    }

    const phrasePattern = `%${loweredQuery}%`;
    const coverageSqlParts = [
      'lower(m.content) LIKE ?',
      'lower(COALESCE(m.source, \'\')) LIKE ?',
    ];
    const coverageParams: Array<string | number> = [phrasePattern, phrasePattern];

    for (const token of tokens) {
      const pattern = `%${token.toLowerCase()}%`;
      coverageSqlParts.push('lower(m.content) LIKE ?');
      coverageParams.push(pattern);
    }

    const rows = this.db.prepare(
      `SELECT id, role, content, token_estimate, created_at, session_id, source
       FROM conversation_messages m
       WHERE (${coverageSqlParts.join(' OR ')})${filterParts.length > 0 ? ` AND ${filterParts.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...coverageParams, ...filterParams, fetchLimit) as Array<{
      id: number;
      role: ConversationRole;
      content: string;
      token_estimate: number;
      created_at: string;
      session_id: string | null;
      source: string | null;
    }>;

    const bigrams = this.extractQueryNgrams(tokens, 2);
    const ranked: RankedConversationMessage[] = [];

    for (const row of rows) {
      const lowerContent = row.content.toLowerCase();
      const lowerSource = (row.source ?? '').toLowerCase();
      const matchedTokens = tokens.filter((token) => lowerContent.includes(token) || lowerSource.includes(token));
      const matchedBigrams = bigrams.filter((bigram) => lowerContent.includes(bigram) || lowerSource.includes(bigram));
      const hasPhrase = lowerContent.includes(loweredQuery) || lowerSource.includes(loweredQuery);
      const coverage = tokens.length > 0 ? matchedTokens.length / tokens.length : 0;
      const score = (hasPhrase ? 50 : 0)
        + matchedTokens.length * 12
        + matchedBigrams.length * 10
        + coverage * 25
        + (row.role === 'assistant' ? 5 : 0);

      const hasEnoughCoverage = hasPhrase
        || tokens.length <= 1
        || coverage >= 0.5
        || matchedBigrams.length > 0;
      if (!hasEnoughCoverage || score <= 0) {
        continue;
      }

      ranked.push({
        message: {
          id: row.id,
          role: row.role,
          ...(options.includeFullContent ? { content: row.content } : {}),
          contentSnippet: this.buildConversationSnippet(row.content, tokens, loweredQuery),
          tokenEstimate: row.token_estimate,
          createdAt: row.created_at,
          ...(row.session_id ? { sessionId: row.session_id } : {}),
          ...(row.source ? { source: row.source } : {}),
          matchReasons: Array.from(new Set([
            ...(hasPhrase ? ['phrase'] : []),
            ...(matchedBigrams.length > 0 ? ['ngram'] : []),
            ...(matchedTokens.length > 0 ? ['token'] : []),
          ])),
        },
        score,
      });
    }

    return ranked
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return this.compareIsoDateDesc(a.message.createdAt, b.message.createdAt);
      })
      .slice(0, options.limit)
      .map((entry) => entry.message);
  }

  private readConversationMessagesById(messageIds: number[], includeFullContent: boolean): ConversationHistorySearchResult[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT id, role, content, token_estimate, created_at, session_id, source
       FROM conversation_messages
       WHERE id IN (${placeholders})
       ORDER BY id ASC`,
    ).all(...messageIds) as Array<{
      id: number;
      role: ConversationRole;
      content: string;
      token_estimate: number;
      created_at: string;
      session_id: string | null;
      source: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      ...(includeFullContent ? { content: row.content } : {}),
      contentSnippet: this.buildConversationSnippet(row.content, [], ''),
      tokenEstimate: row.token_estimate,
      createdAt: row.created_at,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.source ? { source: row.source } : {}),
      matchReasons: ['id'],
    }));
  }

  private buildConversationSnippet(content: string, tokens: string[], loweredQuery: string): string {
    const singleLine = content.replace(/\s+/g, ' ').trim();
    if (!singleLine) return '';

    const lowered = singleLine.toLowerCase();
    const phraseIndex = loweredQuery ? lowered.indexOf(loweredQuery) : -1;
    const tokenIndex = tokens
      .map((token) => lowered.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? -1;
    const anchor = phraseIndex >= 0 ? phraseIndex : tokenIndex;

    if (anchor < 0) {
      return this.createSnippet(singleLine, 220) ?? singleLine.slice(0, 220);
    }

    const start = Math.max(0, anchor - 70);
    const end = Math.min(singleLine.length, anchor + 150);
    const window = singleLine.slice(start, end).trim();
    return `${start > 0 ? '…' : ''}${window}${end < singleLine.length ? '…' : ''}`;
  }

  private extractQueryNgrams(tokens: string[], size: number): string[] {
    const ngrams: string[] = [];
    for (let index = 0; index <= tokens.length - size; index++) {
      ngrams.push(tokens.slice(index, index + size).join(' '));
    }
    return ngrams;
  }

  private parseTags(tagsJson: string): string[] {
    try {
      const parsed = JSON.parse(tagsJson);
      return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseIds(idsJson: string): number[] {
    try {
      const parsed = JSON.parse(idsJson);
      return Array.isArray(parsed)
        ? parsed.filter(id => Number.isInteger(id) && id > 0).map(id => Number(id))
        : [];
    } catch {
      return [];
    }
  }

  private getStatusPriority(status: MemoryStatus): number {
    switch (status) {
      case 'active':
        return 0;
      case 'needs_recheck':
        return 1;
      case 'superseded':
        return 2;
      case 'invalidated':
        return 3;
      default:
        return 99;
    }
  }

  private compareIsoDateDesc(a?: string | null, b?: string | null): number {
    const timeA = a ? Date.parse(a) : 0;
    const timeB = b ? Date.parse(b) : 0;
    return timeB - timeA;
  }
}

export class MemoryManager extends EventEmitter {
  private readonly store: MemoryStore;
  private readonly distillationThresholdTokens: number;
  private readonly distiller?: MemoryDistiller;
  private readonly memorySnapshotLimit: number;
  private activeRun: Promise<void> | null = null;
  private rerunQueued = false;
  private rerunForceQueued = false;
  private status: MemorySidekickStatus;

  constructor(options: MemoryManagerOptions = {}) {
    super();
    this.store = new MemoryStore(options.dbPath);
    this.distillationThresholdTokens = Math.max(1, Math.round(options.distillationThresholdTokens ?? 2_000));
    this.distiller = options.distiller;
    this.memorySnapshotLimit = Math.max(1, Math.min(MAX_LIMIT, Math.round(options.memorySnapshotLimit ?? 6)));
    this.status = {
      state: this.distiller ? 'idle' : 'disabled',
      pendingTokenEstimate: this.getPendingTokenEstimate(),
      distillationThresholdTokens: this.distillationThresholdTokens,
      lastSavedCount: 0,
      rerunQueued: false,
    };
  }

  get databasePath(): string {
    return this.store.databasePath;
  }

  getTools(): MemoryToolDef[] {
    return this.store.getTools();
  }

  hasTool(name: string): boolean {
    return this.store.hasTool(name);
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    this.emitOperation('tool', 'call', {
      tool: name,
      args: this.toLogValue(args),
    });

    try {
      const result = await this.store.callTool(name, args);
      this.emitOperation('tool', 'result', {
        tool: name,
        args: this.toLogValue(args),
        result: this.toLogValue(result),
      });
      return result;
    } catch (error) {
      this.emitOperation('tool', 'error', {
        tool: name,
        args: this.toLogValue(args),
        error: this.formatError(error),
      });
      throw error;
    }
  }

  saveMemory(args: SaveMemoryArgs): SaveMemoryResult {
    return this.saveMemoryFrom('api', args);
  }

  queryMemory(args: QueryMemoryArgs): QueryMemoryResult {
    return this.queryMemoryFrom('api', args);
  }

  deepSearchHistory(args: DeepSearchHistoryArgs): DeepSearchHistoryResult {
    return this.deepSearchHistoryFrom('api', args);
  }

  recordConversationMessage(input: ConversationMessageInput): ArchivedConversationMessage {
    const archived = this.store.appendConversationMessage(input);
    this.emitOperation('conversation', 'recorded', {
      messageId: archived.id,
      role: archived.role,
      tokenEstimate: archived.tokenEstimate,
      source: archived.source ?? null,
      content: archived.content,
    });
    return archived;
  }

  recordConversationTurn(messages: ConversationMessageInput[]): ArchivedConversationMessage[] {
    return messages.map((message) => this.recordConversationMessage(message));
  }

  maybeScheduleDistillation(options: { force?: boolean; reason?: string } = {}): void {
    if (!this.distiller) {
      this.updateStatus({ state: 'disabled' });
      return;
    }

    const pendingTokenEstimate = this.getPendingTokenEstimate();
    if (!options.force && pendingTokenEstimate < this.distillationThresholdTokens) {
      if (!this.activeRun) {
        this.updateStatus({ state: 'idle', pendingTokenEstimate, rerunQueued: false });
      }
      return;
    }

    if (this.activeRun) {
      this.rerunQueued = true;
      this.rerunForceQueued = this.rerunForceQueued || Boolean(options.force);
      this.updateStatus({ state: 'pending', pendingTokenEstimate, rerunQueued: true });
      return;
    }

    this.updateStatus({ state: 'pending', pendingTokenEstimate, rerunQueued: false, lastError: undefined });
    this.emitOperation('distillation', 'scheduled', {
      pendingTokenEstimate,
      distillationThresholdTokens: this.distillationThresholdTokens,
      forced: Boolean(options.force),
      reason: options.reason ?? null,
    });
    this.activeRun = this.runDistillationDeferred(Boolean(options.force));
    void this.activeRun.finally(() => {
      this.activeRun = null;
      if (this.rerunQueued) {
        const force = this.rerunForceQueued;
        this.rerunQueued = false;
        this.rerunForceQueued = false;
        this.maybeScheduleDistillation({
          force,
          ...(force ? { reason: 'queued-priority-rerun' } : {}),
        });
      } else if (this.status.state !== 'error') {
        this.updateStatus({
          state: this.distiller ? 'idle' : 'disabled',
          pendingTokenEstimate: this.getPendingTokenEstimate(),
          rerunQueued: false,
        });
      }
    });
  }

  async flushSidekick(): Promise<void> {
    while (this.activeRun) {
      await this.activeRun;
    }
  }

  requestPriorityDistillation(reason = 'priority'): void {
    this.maybeScheduleDistillation({ force: true, reason });
  }

  getSidekickStatus(): MemorySidekickStatus {
    return {
      ...this.status,
      pendingTokenEstimate: this.getPendingTokenEstimate(),
      rerunQueued: this.rerunQueued,
    };
  }

  close(): void {
    this.store.close();
  }

  private async runDistillationDeferred(force = false): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await this.runDistillation(force);
  }

  private async runDistillation(force = false): Promise<void> {
    if (!this.distiller) return;

    const lastDistilledMessageId = Number(this.store.getRuntimeState(LAST_DISTILLED_MESSAGE_ID_KEY) ?? 0);
    const messages = this.store.getConversationMessagesSince(lastDistilledMessageId);
    const pendingTokenEstimate = messages.reduce((sum, message) => sum + message.tokenEstimate, 0);

    if (messages.length === 0 || (!force && pendingTokenEstimate < this.distillationThresholdTokens)) {
      this.updateStatus({ state: 'idle', pendingTokenEstimate, rerunQueued: this.rerunQueued });
      return;
    }

    const combinedText = messages.map(message => `${message.role}: ${message.content}`).join('\n');
    const memorySnapshot = this.store.getRelevantActiveMemoriesForText(combinedText, this.memorySnapshotLimit);

    this.updateStatus({
      state: 'running',
      pendingTokenEstimate,
      rerunQueued: this.rerunQueued,
      lastError: undefined,
    });
    this.emitOperation('distillation', 'started', {
      lastDistilledMessageId,
      messageCount: messages.length,
      pendingTokenEstimate,
      memorySnapshotCount: memorySnapshot.length,
      messageIds: messages.map((message) => message.id),
      forced: force,
    });

    try {
      const result = await this.distiller({
        messages,
        memorySnapshot,
        pendingTokenEstimate,
        distillationThresholdTokens: this.distillationThresholdTokens,
      });

      const savedMemories = (result.memories ?? [])
        .map((candidate) => this.saveMemoryFrom('sidekick', candidate));
      const saved = savedMemories.length;

      const lastMessage = messages.at(-1);
      if (lastMessage) {
        this.store.setRuntimeState(LAST_DISTILLED_MESSAGE_ID_KEY, String(lastMessage.id));
      }

      this.emitOperation('distillation', 'completed', {
        lastProcessedMessageId: lastMessage?.id ?? null,
        pendingTokenEstimate,
        savedCount: saved,
        summary: result.summary ?? null,
        memories: savedMemories.map((memory) => ({
          memoryId: memory.memoryId,
          subject: memory.subject,
          status: memory.status,
        })),
      });

      this.updateStatus({
        state: 'idle',
        pendingTokenEstimate: this.getPendingTokenEstimate(),
        lastRunAt: new Date().toISOString(),
        lastSummary: result.summary ?? (saved > 0 ? `Saved ${saved} memory item${saved === 1 ? '' : 's'}.` : 'No durable memory found.'),
        lastSavedCount: saved,
        lastError: undefined,
        rerunQueued: this.rerunQueued,
      });
    } catch (error) {
      this.emitOperation('distillation', 'error', {
        pendingTokenEstimate,
        error: this.formatError(error),
      });
      this.updateStatus({
        state: 'error',
        pendingTokenEstimate,
        lastError: error instanceof Error ? error.message : String(error),
        rerunQueued: this.rerunQueued,
      });
    }
  }

  private getPendingTokenEstimate(): number {
    const lastDistilledMessageId = Number(this.store.getRuntimeState(LAST_DISTILLED_MESSAGE_ID_KEY) ?? 0);
    return this.store.getPendingConversationTokenEstimate(lastDistilledMessageId);
  }

  private updateStatus(partial: Partial<MemorySidekickStatus>): void {
    this.status = {
      ...this.status,
      ...partial,
    };
    this.emit('status', this.getSidekickStatus());
    this.emitOperation('status', 'updated', {
      state: this.status.state,
      pendingTokenEstimate: this.status.pendingTokenEstimate,
      distillationThresholdTokens: this.status.distillationThresholdTokens,
      lastRunAt: this.status.lastRunAt ?? null,
      lastSummary: this.status.lastSummary ?? null,
      lastSavedCount: this.status.lastSavedCount,
      lastError: this.status.lastError ?? null,
      rerunQueued: this.status.rerunQueued,
    });
  }

  private saveMemoryFrom(source: 'api' | 'sidekick', args: SaveMemoryArgs): SaveMemoryResult {
    const result = this.store.saveMemory(args);
    this.emitOperation('memory', 'saved', {
      source,
      args: this.toLogValue(args),
      result: this.toLogValue(result),
    });
    return result;
  }

  private queryMemoryFrom(source: 'api', args: QueryMemoryArgs): QueryMemoryResult {
    const result = this.store.queryMemory(args);
    this.emitOperation('memory', 'queried', {
      source,
      args: this.toLogValue(args),
      result: this.toLogValue({
        mode: result.mode,
        count: result.count,
        summary: result.summary,
        memories: result.memories.map((memory) => ({
          id: memory.id,
          subject: memory.subject,
          status: memory.status,
          matchReasons: memory.matchReasons,
        })),
      }),
    });
    return result;
  }

  private deepSearchHistoryFrom(source: 'api', args: DeepSearchHistoryArgs): DeepSearchHistoryResult {
    const result = this.store.deepSearchHistory(args);
    this.emitOperation('memory', 'history_searched', {
      source,
      args: this.toLogValue(args),
      result: this.toLogValue({
        mode: result.mode,
        count: result.count,
        summary: result.summary,
        messages: result.messages.map((message) => ({
          id: message.id,
          role: message.role,
          createdAt: message.createdAt,
          matchReasons: message.matchReasons,
        })),
      }),
    });
    return result;
  }

  private emitOperation(
    category: MemoryOperationCategory,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    this.emit('operation', {
      ts: new Date().toISOString(),
      category,
      action,
      payload,
    } satisfies MemoryOperationEvent);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private toLogValue(value: unknown): Record<string, unknown> | string | number | boolean | null | Array<unknown> {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.toLogValue(entry));
    }
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, this.toLogValue(entry)]),
      );
    }
    return String(value);
  }
}
