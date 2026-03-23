# Memory Mechanism

## Overview

The agent now has a SQLite-backed long-term memory layer designed to reduce repeated relearning across sessions.
It stores distilled reusable knowledge such as site-specific lessons, workflows, preferences, and troubleshooting notes.

The runtime database lives at:

```text
data/agent-memory.sqlite
```

This file is local-only and ignored by git.

## Goals

- Preserve useful knowledge between sessions
- Reduce repeated token burn on the same sites and workflows
- Support iterative search with short results and follow-up refinement
- Keep memory structured and queryable instead of growing Markdown endlessly

## Tools

### `save_memory`

Stores concise reusable knowledge.

Typical fields:

- `scope`: `site`, `workflow`, `user`, `project`, `task`, or `general`
- `subject`: short topic such as `canva`, `github billing`, or `invoice export`
- `summary`: one-sentence takeaway
- `details`: optional deeper instructions, gotchas, or verification notes
- `tags`: optional retrieval hints
- `confidence`: 0.0 to 1.0

Use it for:

- repeatable site behavior
- durable user preferences
- successful workflows
- important recovery patterns

Avoid using it for:

- raw transcript dumps
- one-off noise
- transient page state that is unlikely to matter again

### `query_memory`

Searches long-term memory with both structured filtering and full-text search.

It supports:

- natural-language query text
- scope filtering
- subject filtering
- tag filtering
- short search results for iterative follow-up search
- exact reads by `memoryIds`

The intended pattern is:

1. Do a broad search.
2. Look at the short hits.
3. Refine the search if needed.
4. Read full details for the most promising memory IDs.

## Retrieval Strategy

`query_memory` uses a hybrid approach:

- FTS search over subject, summary, details, and tags
- structured filters on scope, subject, and tags
- fallback text matching
- recency and confidence-aware ranking

This lets the agent do both:

- targeted lookups like `scope=site subject=canva`
- broader searches like `canva upload sidebar drag drop`

## Why SQLite

SQLite is a good fit here because it is:

- embedded
- fast enough for agent memory workloads
- easy to ship with the app
- capable of indexed queries plus FTS

This design is intentionally retrieval-oriented, not analytics-oriented.

## Memory Lifecycle

### Save

The agent should save only distilled knowledge that is likely to help future sessions.

### Search

Before re-learning a known site or workflow, the agent should search memory first.

### Refine

Short search results are expected to drive follow-up search with better keywords.

### Read

When a specific memory looks useful, the agent can request full details by ID.

### Verify

Memory is guidance, not guaranteed truth.
The agent should still verify important assumptions against the live page because web apps change over time.

## Agent Prompting Rules

The BrowserAgent system prompt now tells the model to:

- query memory before re-learning repeated workflows
- use short hits for follow-up search
- save distilled reusable lessons
- avoid saving raw transcripts

This keeps the memory layer useful without forcing the model to read a giant blob every turn.

## Tests

The memory layer is covered by:

```bash
node test-memory.mjs
```

That suite verifies:

- save/update behavior
- structured plus FTS retrieval
- follow-up exact reads by ID
- BrowserAgent tool registration

The full project suite also includes memory coverage:

```bash
npm test
```

## Resetting Memory

To clear long-term memory, stop the app and delete:

```text
data/agent-memory.sqlite
```

The app will recreate the schema automatically on next start.
