import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export interface MemoryToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type MemoryScope = 'site' | 'workflow' | 'user' | 'project' | 'task' | 'general';

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
}

interface SaveMemoryArgs {
  scope?: MemoryScope;
  subject: string;
  summary: string;
  details?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  sourceSessionId?: string;
  lastVerifiedAt?: string;
}

interface QueryMemoryArgs {
  query?: string;
  scope?: MemoryScope;
  subject?: string;
  tags?: string[];
  limit?: number;
  includeFullDetails?: boolean;
  memoryIds?: number[];
}

interface RankedMemory {
  row: MemoryRow;
  hasFtsMatch: boolean;
  ftsRank: number;
  matchReasons: Set<string>;
}

const MEMORY_SCOPES: MemoryScope[] = ['site', 'workflow', 'user', 'project', 'task', 'general'];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath = path.join(process.cwd(), 'data', 'agent-memory.sqlite')) {
    process.env.NODE_NO_WARNINGS ??= '1';
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initialize();
  }

  getTools(): MemoryToolDef[] {
    return [
      {
        name: 'save_memory',
        description: 'Store concise reusable knowledge for future sessions. Save durable lessons, preferences, workflows, or site knowledge, not raw conversation transcripts.',
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
              description: 'Optional longer detail with steps, gotchas, verification hints, or caveats.',
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
          },
          required: ['subject', 'summary'],
          additionalProperties: false,
        },
      },
      {
        name: 'query_memory',
        description: 'Search long-term memory with both structured filters and full-text search. Returns short results for iterative follow-up search, or full records when memoryIds are provided.',
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
        last_verified_at TEXT
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
    `);
  }

  private saveMemory(args: SaveMemoryArgs) {
    const now = new Date().toISOString();
    const scope = this.normalizeScope(args.scope);
    const subject = this.requireText(args.subject, 'subject');
    const summary = this.requireText(args.summary, 'summary');
    const details = this.normalizeOptionalText(args.details);
    const tags = this.normalizeTags(args.tags);
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(' ');
    const confidence = this.normalizeConfidence(args.confidence);
    const source = this.normalizeOptionalText(args.source) ?? null;
    const sourceSessionId = this.normalizeOptionalText(args.sourceSessionId) ?? null;
    const lastVerifiedAt = this.normalizeOptionalText(args.lastVerifiedAt) ?? null;

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
             updated_at = ?, last_verified_at = COALESCE(?, last_verified_at)
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
        existing.id,
      );
      memoryId = existing.id;
      action = 'updated';
    } else {
      const result = this.db.prepare(
        `INSERT INTO memories (
          scope, subject, summary, details, tags_json, tags_text, confidence,
          source, source_session_id, created_at, updated_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      memoryId = Number(result.lastInsertRowid);
      action = 'created';
    }

    this.replaceFtsEntry(memoryId);

    return {
      status: action,
      memoryId,
      scope,
      subject,
      summary,
      tags,
      confidence,
      dbPath: this.dbPath,
    };
  }

  private queryMemory(args: QueryMemoryArgs) {
    const memoryIds = this.normalizeMemoryIds(args.memoryIds);
    const includeFullDetails = args.includeFullDetails === true || memoryIds.length > 0;

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
      },
      summary: memories.length > 0
        ? `Found ${memories.length} memory hit${memories.length === 1 ? '' : 's'} for iterative follow-up search or direct reuse.`
        : 'No matching memories found.',
      memories,
    };
  }

  private searchMemories(options: {
    query?: string;
    scope?: string;
    subject?: string;
    tags: string[];
    limit: number;
    includeFullDetails: boolean;
  }) {
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
        this.mergeRankedRow(ranked, row, true, Number.isFinite(row.fts_rank) ? row.fts_rank : Number.MAX_SAFE_INTEGER, 'fts');
      }
    }

    if (tokens.length > 0) {
      const likeClauses = tokens.map(() => '(lower(m.subject) LIKE ? OR lower(m.summary) LIKE ? OR lower(m.details) LIKE ? OR lower(m.tags_text) LIKE ?)').join(' OR ');
      const likeParams = tokens.flatMap(token => {
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

  private readMemories(memoryIds: number[], includeFullDetails: boolean) {
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
    ).all(...memoryIds) as MemoryRow[];

    this.touchMemories(rows.map(row => row.id));
    return rows.map(row => this.toSearchResult(row, new Set(['read']), includeFullDetails));
  }

  private toSearchResult(row: MemoryRow, matchReasons: Set<string>, includeFullDetails: boolean) {
    const tags = this.parseTags(row.tags_json);
    return {
      id: row.id,
      scope: row.scope,
      subject: row.subject,
      summary: row.summary,
      details: includeFullDetails ? row.details : undefined,
      detailsSnippet: includeFullDetails ? undefined : this.createSnippet(row.details),
      tags,
      confidence: row.confidence,
      source: row.source ?? undefined,
      sourceSessionId: row.source_session_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
      lastVerifiedAt: row.last_verified_at ?? undefined,
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

  private extractSearchTokens(query?: string): string[] {
    if (!query) return [];
    return Array.from(new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9._-]{2,}/g) ?? [],
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

  private compareIsoDateDesc(a?: string | null, b?: string | null): number {
    const timeA = a ? Date.parse(a) : 0;
    const timeB = b ? Date.parse(b) : 0;
    return timeB - timeA;
  }
}
