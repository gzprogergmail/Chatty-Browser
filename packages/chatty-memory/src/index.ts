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
  scope?: MemoryScope;
  subject?: string;
  tags?: string[];
  limit?: number;
  includeFullDetails?: boolean;
  memoryIds?: number[];
  includeInactive?: boolean;
  status?: MemoryStatus | MemoryStatus[];
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
  status: MemoryStatus;
  resolvedByMemoryId?: number;
  resolutionNote?: string;
  supersedesMemoryIds: number[];
  invalidatesMemoryIds: number[];
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
  memoryStatus: MemoryStatus;
  supersedesMemoryIds: number[];
  invalidatesMemoryIds: number[];
  dbPath: string;
}

export interface QueryMemoryResult {
  mode: 'search' | 'read';
  count: number;
  query?: string;
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
    this.replaceFtsEntry(memoryId);

    return {
      status: action,
      memoryId,
      scope,
      subject,
      summary,
      tags,
      confidence,
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
    const query = this.normalizeOptionalText(args.query);
    const scope = this.normalizeScope(args.scope, false);
    const subject = this.normalizeOptionalText(args.subject);
    const tags = this.normalizeTags(args.tags);
    const memories = this.searchMemories({
      query,
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
      filters: {
        scope,
        subject,
        tags,
        includeFullDetails,
        limit,
        statuses,
      },
      summary: memories.length > 0
        ? `Found ${memories.length} memory hit${memories.length === 1 ? '' : 's'} for iterative follow-up search or direct reuse.`
        : 'No matching memories found.',
      memories,
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
    return {
      id: Number(result.lastInsertRowid),
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

      CREATE TABLE IF NOT EXISTS memory_runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.migrateMemoriesTable();
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
    return ordered.map(item => this.toSearchResult(item.row, item.matchReasons, options.includeFullDetails));
  }

  private readMemories(memoryIds: number[], includeFullDetails: boolean): MemorySearchResult[] {
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
    ).all(...memoryIds) as MemoryRow[];

    this.touchMemories(rows.map(row => row.id));
    return rows.map((row) => this.toSearchResult(row, new Set(['read']), includeFullDetails));
  }

  private toSearchResult(row: MemoryRow, matchReasons: Set<string>, includeFullDetails: boolean): MemorySearchResult {
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
      status: row.status,
      resolvedByMemoryId: row.resolved_by_memory_id ?? undefined,
      resolutionNote: row.resolution_note ?? undefined,
      supersedesMemoryIds: this.parseIds(row.supersedes_json),
      invalidatesMemoryIds: this.parseIds(row.invalidates_json),
      matchReasons: Array.from(matchReasons),
    };
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
    return this.store.callTool(name, args);
  }

  saveMemory(args: SaveMemoryArgs): SaveMemoryResult {
    return this.store.saveMemory(args);
  }

  queryMemory(args: QueryMemoryArgs): QueryMemoryResult {
    return this.store.queryMemory(args);
  }

  recordConversationMessage(input: ConversationMessageInput): ArchivedConversationMessage {
    return this.store.appendConversationMessage(input);
  }

  recordConversationTurn(messages: ConversationMessageInput[]): ArchivedConversationMessage[] {
    return messages.map((message) => this.recordConversationMessage(message));
  }

  maybeScheduleDistillation(): void {
    if (!this.distiller) {
      this.updateStatus({ state: 'disabled' });
      return;
    }

    const pendingTokenEstimate = this.getPendingTokenEstimate();
    if (pendingTokenEstimate < this.distillationThresholdTokens) {
      if (!this.activeRun) {
        this.updateStatus({ state: 'idle', pendingTokenEstimate, rerunQueued: false });
      }
      return;
    }

    if (this.activeRun) {
      this.rerunQueued = true;
      this.updateStatus({ state: 'pending', pendingTokenEstimate, rerunQueued: true });
      return;
    }

    this.activeRun = this.runDistillation();
    void this.activeRun.finally(() => {
      this.activeRun = null;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        this.maybeScheduleDistillation();
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

  private async runDistillation(): Promise<void> {
    if (!this.distiller) return;

    const lastDistilledMessageId = Number(this.store.getRuntimeState(LAST_DISTILLED_MESSAGE_ID_KEY) ?? 0);
    const messages = this.store.getConversationMessagesSince(lastDistilledMessageId);
    const pendingTokenEstimate = messages.reduce((sum, message) => sum + message.tokenEstimate, 0);

    if (messages.length === 0 || pendingTokenEstimate < this.distillationThresholdTokens) {
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

    try {
      const result = await this.distiller({
        messages,
        memorySnapshot,
        pendingTokenEstimate,
        distillationThresholdTokens: this.distillationThresholdTokens,
      });

      const saved = (result.memories ?? [])
        .map((candidate) => this.store.saveMemory(candidate))
        .length;

      const lastMessage = messages.at(-1);
      if (lastMessage) {
        this.store.setRuntimeState(LAST_DISTILLED_MESSAGE_ID_KEY, String(lastMessage.id));
      }

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
  }
}
