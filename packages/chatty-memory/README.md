# `@chatty-browser/memory`

Portable SQLite-backed long-term memory for agentic Node.js apps.

This package is designed to live inside the repo as an independent package, not as application-only code. The main app consumes it through a thin wrapper, but the package owns its own storage model, background sidekick workflow, and test suite.

## What This Package Solves

Agent apps often need two different kinds of memory:

- raw conversational history for later analysis or distillation
- distilled long-term memory that is compact, queryable, and reusable across sessions

Saving everything as Markdown or replaying whole chat logs makes memory noisy and expensive. This package keeps raw message history in SQLite, stores reusable memories as structured records, and supports a background sidekick LLM that periodically distills recent conversation into durable memories without blocking the main chat thread.

## Package Goals

- portable: usable by other Node.js apps without depending on this app’s browser logic
- local-first: embedded SQLite storage with no required external services
- conflict-aware: newer discoveries can supersede or invalidate older memories
- retrieval-oriented: optimized for small, high-signal search results
- sidekick-friendly: supports background distillation by a separate LLM worker
- testable: package behavior is covered independently from app integration

## Main Concepts

### `MemoryStore`

`MemoryStore` is the low-level persistence and retrieval layer.

Responsibilities:

- create and migrate the SQLite schema
- save structured memories
- search memories with full-text and structured filters
- record raw conversation messages
- track runtime state such as the distillation cursor
- manage conflict metadata such as `superseded` and `invalidated`

Use `MemoryStore` when you want direct control over reads and writes.

### `MemoryManager`

`MemoryManager` is the higher-level runtime.

Responsibilities:

- delegate memory tool calls to `MemoryStore`
- record conversation turns
- decide when enough new conversation has accumulated to trigger background distillation
- call a provided sidekick distiller asynchronously
- save sidekick-produced memories back into the store
- expose current sidekick status for UI display

Use `MemoryManager` when you want the complete operational flow, not just storage.

## Public API

The package exports:

- `MemoryStore`
- `MemoryManager`
- `MemoryScope`
- `MemoryStatus`
- `SaveMemoryArgs`
- `SaveMemoryResult`
- `QueryMemoryArgs`
- `QueryMemoryResult`
- `MemorySearchResult`
- `ConversationMessageInput`
- `ArchivedConversationMessage`
- `MemoryDistillationRequest`
- `MemoryDistillationResult`
- `MemoryDistiller`
- `MemorySidekickStatus`
- `MemoryToolDef`

## Storage Model

By default the database lives at:

```text
data/agent-memory.sqlite
```

The path is configurable through the package constructors.

### Tables

The package maintains three main tables.

#### `memories`

Stores distilled long-term memories.

Key fields:

- `scope`
- `subject`
- `summary`
- `details`
- `tags_json`
- `confidence`
- `last_verified_at`
- `status`
- `resolved_by_memory_id`
- `resolution_note`
- `supersedes_json`
- `invalidates_json`

#### `memories_fts`

An FTS5 virtual table used for memory search over:

- `subject`
- `summary`
- `details`
- `tags`

#### `conversation_messages`

Stores the raw message archive used by the sidekick distiller.

Key fields:

- `role`
- `content`
- `token_estimate`
- `created_at`
- `session_id`
- `source`

#### `memory_runtime_state`

Stores small runtime state values such as:

- `last_distilled_message_id`

This allows distillation to process only the new message delta instead of re-reading the entire conversation archive every time.

## Memory Status and Conflict Management

Long-term memory must be revisable. This package treats memories as claims that can be corrected over time.

Supported statuses:

- `active`
- `superseded`
- `invalidated`
- `needs_recheck`

### Why This Matters

Agents often learn something that later turns out to be wrong:

- a page element moved
- a workflow changed
- a prior UI interpretation was incorrect
- a user preference was updated

If memory were append-only, searches would keep returning stale guidance. Instead, this package lets newer memories resolve older ones.

### Conflict Resolution Flow

When saving a new memory you can provide:

- `supersedesMemoryIds`
- `invalidatesMemoryIds`
- `invalidationReason`

The package will then:

1. save or update the new memory
2. mark older memories as `superseded` or `invalidated`
3. link the older rows back to the new row with `resolved_by_memory_id`
4. store the explanation in `resolution_note`

Default search behavior only returns `active` memories, so stale memories stop polluting ordinary retrieval.

If you need older context, query with:

- `includeInactive: true`
- or an explicit `status` filter

## Query Model

`query_memory` and `queryMemory()` both support:

- natural-language `query`
- `scope` filter
- `subject` filter
- `tags` filter
- `limit`
- `includeFullDetails`
- direct lookup by `memoryIds`
- `includeInactive`
- explicit `status` filtering

### Search Strategy

Search uses a hybrid retrieval model:

1. FTS5 match over `subject`, `summary`, `details`, and `tags`
2. fallback text matching over the same fields
3. structured filters on scope, subject, tags, and status
4. ranking by:
   - memory status priority
   - FTS relevance
   - confidence
   - recency / verification timestamp

### Why Search Results Are Short by Default

The intended retrieval pattern is:

1. broad search
2. inspect short hits
3. refine the query
4. read a few memories in full by ID

This keeps prompt payloads small and lets the calling agent do iterative retrieval instead of dumping large memory blobs into context.

## Background Sidekick Distillation

One of the central design goals is avoiding main-thread slowdown.

The package supports a separate “sidekick” LLM through the `MemoryManager` `distiller` callback.

### What the Sidekick Does

The sidekick receives:

- the recent raw conversation delta
- a small snapshot of currently relevant active memories
- the pending token estimate
- the configured threshold

It returns:

- a short run summary
- zero or more structured memory candidates

The package then persists those candidates using the same conflict-aware save path as manual memory writes.

### Trigger Model

`MemoryManager` watches how many estimated new tokens have accumulated since the last distillation checkpoint.

When the threshold is crossed:

- the main thread is not blocked
- the sidekick runs in the background
- the package updates sidekick status for the UI

If additional conversation arrives while a distillation run is in progress:

- the manager does not start a second concurrent run
- it marks a rerun as queued
- it schedules another pass after the current run finishes

This keeps the sidekick serialized and predictable.

### Sidekick Status

`getSidekickStatus()` returns:

- `state`
- `pendingTokenEstimate`
- `distillationThresholdTokens`
- `lastRunAt`
- `lastSummary`
- `lastSavedCount`
- `lastError`
- `rerunQueued`

This is intended for UI display such as:

- status bars
- CLI commands like `/memory-status`
- lightweight background task indicators

## Tool Surface

The package exposes two tool definitions through `getTools()`:

- `save_memory`
- `query_memory`

This is intentionally narrow. The sidekick mechanism is package-internal runtime behavior rather than a tool the main agent has to micromanage.

### `save_memory`

Use this when the agent or sidekick already knows what should be stored.

Typical uses:

- save a repeatable workflow
- record a durable user preference
- store a corrected understanding of a site
- supersede or invalidate older memory IDs

### `query_memory`

Use this before re-learning a site or workflow from scratch.

Typical uses:

- broad lookup for a site such as Canva or GitHub
- follow-up search based on short hits
- full read of selected memory IDs
- optional retrieval of inactive records during debugging or reconciliation

## Package Usage Example

### Direct Store Usage

```ts
import { MemoryStore } from "@chatty-browser/memory";

const store = new MemoryStore("./data/agent-memory.sqlite");

store.saveMemory({
  scope: "site",
  subject: "canva",
  summary: "Uploads are in the left sidebar Uploads panel.",
  details: "Use the left rail instead of Apps.",
  tags: ["canva", "uploads"],
});

const results = store.queryMemory({
  query: "canva uploads",
  limit: 3,
});
```

### Full Runtime Usage with a Sidekick

```ts
import { MemoryManager } from "@chatty-browser/memory";

const memory = new MemoryManager({
  dbPath: "./data/agent-memory.sqlite",
  distillationThresholdTokens: 2000,
  async distiller(request) {
    // call your sidekick LLM here
    return {
      summary: "Saved 1 durable memory.",
      memories: [
        {
          scope: "user",
          subject: "response style",
          summary: "The user prefers concise answers.",
          details: "Observed repeatedly across recent turns.",
          tags: ["user", "style"],
          confidence: 0.9,
        },
      ],
    };
  },
});

memory.recordConversationTurn([
  { role: "user", content: "Please keep answers brief." },
  { role: "assistant", content: "Understood." },
]);

memory.maybeScheduleDistillation();
```

## Expected Integration Pattern

The intended application integration is:

1. the app records user and assistant messages into `MemoryManager`
2. the app lets the manager decide when to trigger sidekick distillation
3. the app exposes `getSidekickStatus()` in the UI
4. the app passes `save_memory` and `query_memory` tools to the main agent

This package intentionally does not know anything about:

- Playwright
- browsers
- Copilot-specific tools
- your app’s UI framework

Those concerns belong in the consuming app.

## Migration Behavior

The package is designed to upgrade older local databases.

On startup it:

- creates missing tables
- adds newly required columns to existing `memories` tables
- backfills defaults for new status-related fields

This allows a pre-package memory database to continue working after migration.

## Testing Strategy

This repo intentionally separates package tests from app integration tests.

### Package-Level Tests

Located at:

[package-tests.mjs](/c:/dl/SelfContainedAgent/packages/chatty-memory/test/package-tests.mjs)

These verify:

- save/update behavior
- search behavior
- conflict resolution
- invalidation
- sidekick distillation behavior

### App-Level Tests

The app has its own tests that verify correct package usage rather than package internals.

Examples:

- the browser agent registers memory tools
- the browser agent routes tool calls correctly
- the UI exposes sidekick status

## Design Tradeoffs

### Why SQLite Instead of Markdown

SQLite gives:

- structured updates
- FTS
- indexed retrieval
- conflict metadata
- durable runtime cursors

Markdown is easy to append to, but much harder to rank, update, dedupe, or reconcile when beliefs change.

### Why a Sidekick Callback Instead of Hardcoding an LLM

The package is meant to be portable.

By accepting a `distiller` callback:

- the package stays model-agnostic
- the consuming app can use Copilot, OpenAI, Anthropic, or another local model
- package tests can use deterministic mocks

### Why Default to Active Memories Only

Most retrieval should favor the current best-known guidance.

Older invalidated knowledge is still useful for:

- debugging
- auditability
- conflict inspection

but it should not crowd normal agent prompts.

## Operational Notes

- the database file is local and should usually stay out of git
- SQLite `WAL` mode is enabled
- the package uses simple token estimates for distillation thresholds unless the caller provides explicit estimates
- the package serializes background sidekick runs and queues at most a rerun, rather than spawning unbounded concurrent distillers

## Current Limits

- no vector embeddings yet
- no built-in cross-process locking protocol beyond SQLite behavior
- no automatic contradiction detection without a sidekick or caller-supplied IDs
- no multi-tenant namespacing yet inside one DB

Those can be layered on later without changing the basic package boundary.

## Repo Relationship

In this repo:

- the package lives in [packages/chatty-memory](/c:/dl/SelfContainedAgent/packages/chatty-memory)
- the app consumes it through [src/memory/memory-store.ts](/c:/dl/SelfContainedAgent/src/memory/memory-store.ts)

That separation is intentional and should remain intact as the package evolves.
