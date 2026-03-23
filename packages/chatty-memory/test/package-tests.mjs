import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryManager, MemoryStore } from '../dist/index.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let passed = 0;
let failed = 0;

function logPass(label) {
  console.log(`${PASS} ${label}`);
  passed++;
}

function logFail(label, error) {
  console.log(`${FAIL} ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  failed++;
}

async function test(label, fn) {
  try {
    await fn();
    logPass(label);
  } catch (error) {
    logFail(label, error);
  }
}

async function withTempStore(label, fn) {
  const dir = path.join(process.cwd(), 'test-artifacts', 'memory-package', label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.sqlite');

  try {
    return await fn(dir, dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── Chatty Memory Package Tests ───────────────────────────────────────\n');

await test('MemoryStore saves a reusable memory record', async () => {
  await withTempStore('save-memory-create', async (dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      const result = store.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Canva editor usually needs a short wait after navigation.',
        details: 'Wait for the left sidebar and editor canvas before clicking.',
        tags: ['canva', 'editor', 'timing'],
        confidence: 0.9,
      });

      assert.equal(result.status, 'created');
      assert.equal(result.subject, 'canva');
      assert.ok(fs.existsSync(path.join(dir, 'memory.sqlite')));
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore updates an existing memory instead of duplicating it', async () => {
  await withTempStore('save-memory-update', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      const first = store.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Canva uploads live in the left sidebar.',
        details: 'Open Uploads from the left rail.',
        tags: ['canva'],
        confidence: 0.7,
      });

      const second = store.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Canva uploads live in the left sidebar.',
        details: 'Open Uploads from the left rail, then drag files into the editor.',
        tags: ['canva', 'uploads'],
        confidence: 0.95,
      });

      const query = store.queryMemory({ query: 'canva uploads', includeFullDetails: true, limit: 5 });
      assert.equal(first.memoryId, second.memoryId);
      assert.equal(second.status, 'updated');
      assert.equal(query.count, 1);
      assert.match(query.memories[0].details, /drag files into the editor/);
      assert.deepStrictEqual(query.memories[0].tags, ['canva', 'uploads']);
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore marks older memories as superseded and hides them from default search', async () => {
  await withTempStore('conflict-supersede', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      const oldMemory = store.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Uploads are under Apps.',
        details: 'Open Apps to find uploads.',
        tags: ['canva', 'uploads'],
      });

      const corrected = store.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Uploads are in the left sidebar Uploads panel.',
        details: 'Open Uploads from the left rail instead of Apps.',
        tags: ['canva', 'uploads'],
        supersedesMemoryIds: [oldMemory.memoryId],
        invalidationReason: 'Later testing showed the earlier Apps path was wrong.',
      });

      const activeQuery = store.queryMemory({ query: 'canva uploads', includeFullDetails: true, limit: 5 });
      const inactiveQuery = store.queryMemory({ query: 'canva uploads', includeFullDetails: true, includeInactive: true, limit: 5 });

      assert.equal(activeQuery.count, 1);
      assert.equal(activeQuery.memories[0].id, corrected.memoryId);
      assert.equal(activeQuery.memories[0].status, 'active');

      const superseded = inactiveQuery.memories.find((memory) => memory.id === oldMemory.memoryId);
      assert.ok(superseded);
      assert.equal(superseded.status, 'superseded');
      assert.equal(superseded.resolvedByMemoryId, corrected.memoryId);
      assert.match(superseded.resolutionNote, /earlier Apps path was wrong/);
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore can explicitly invalidate older memories', async () => {
  await withTempStore('conflict-invalidate', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      const stale = store.saveMemory({
        scope: 'workflow',
        subject: 'invoice export',
        summary: 'Export invoices without checking totals.',
        details: 'Direct export used to be enough.',
      });

      store.saveMemory({
        scope: 'workflow',
        subject: 'invoice export',
        summary: 'Always verify totals before exporting invoices.',
        details: 'The older shortcut caused incorrect exports.',
        invalidatesMemoryIds: [stale.memoryId],
        invalidationReason: 'The shortcut caused incorrect exports.',
      });

      const invalidated = store.queryMemory({
        memoryIds: [stale.memoryId],
        includeFullDetails: true,
      }).memories[0];

      assert.equal(invalidated.status, 'invalidated');
      assert.match(invalidated.resolutionNote, /incorrect exports/);
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore persists related memory edges and returns them in query results', async () => {
  await withTempStore('related-memory-edges', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      const first = store.saveMemory({
        scope: 'workflow',
        subject: 'invoice export',
        summary: 'Always run verification before exporting invoices.',
        tags: ['invoice', 'export', 'verification'],
      });

      const second = store.saveMemory({
        scope: 'workflow',
        subject: 'totals check',
        summary: 'Check totals before finalizing the workflow.',
        tags: ['verification', 'totals'],
        relatedMemoryIds: [first.memoryId],
      });

      assert.deepStrictEqual(second.relatedMemoryIds, [first.memoryId]);

      const firstRead = store.queryMemory({ memoryIds: [first.memoryId], includeFullDetails: true }).memories[0];
      const secondRead = store.queryMemory({ memoryIds: [second.memoryId], includeFullDetails: true }).memories[0];

      assert.deepStrictEqual(firstRead.relatedMemoryIds, [second.memoryId]);
      assert.deepStrictEqual(secondRead.relatedMemoryIds, [first.memoryId]);
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore can aggregate up to five alternate search phrasings in one query', async () => {
  await withTempStore('multi-query-search', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      store.saveMemory({
        scope: 'site',
        subject: 'bellevue school district tyee',
        summary: 'BSD 405 non-school days apply to Tyee unless the school posts a special schedule.',
        tags: ['bsd', 'tyee', 'calendar'],
      });

      const results = store.queryMemory({
        queries: [
          'none school day of tyee bsd',
          'non school day tyee',
          'bsd 405 tyee calendar',
        ],
        limit: 5,
      });

      assert.equal(results.mode, 'search');
      assert.deepStrictEqual(results.attemptedQueries, [
        'none school day of tyee bsd',
        'non school day tyee',
        'bsd 405 tyee calendar',
      ]);
      assert.equal(results.count, 1);
      assert.match(results.summary, /across 3 search variants/);
      assert.equal(results.memories[0].subject, 'bellevue school district tyee');
    } finally {
      store.close();
    }
  });
});

await test('MemoryStore can deep-search archived conversation history for undistilled findings', async () => {
  await withTempStore('deep-history-search', async (_dir, dbPath) => {
    const store = new MemoryStore(dbPath);

    try {
      store.appendConversationMessage({
        role: 'user',
        content: 'Can you check the Tyee Middle School calendar?',
        source: 'user-command',
      });
      store.appendConversationMessage({
        role: 'assistant',
        content: [
          'I checked BSD 405 and Tyee Middle School follows the district no-school dates unless the school posts a special exception.',
          'Upcoming non-school days include 2026-03-27 and Spring Break from 2026-04-06 through 2026-04-10.',
          'Source: https://www.bsd405.org/about-us/calendar/important-dates-details/~board/calendars/post/important-dates-for-families',
        ].join('\n'),
        source: 'assistant-response',
      });

      const results = store.deepSearchHistory({
        queries: ['Tyee Middle School holidays', 'bsd 405 tyee calendar'],
        limit: 5,
      });

      assert.equal(results.mode, 'history-search');
      assert.ok(results.count >= 1);
      assert.match(results.summary, /archived conversation hit/);
      assert.equal(results.messages[0].role, 'assistant');
      assert.match(results.messages[0].contentSnippet, /Tyee Middle School follows the district no-school dates/i);

      const readBack = store.deepSearchHistory({
        messageIds: [results.messages[0].id],
        includeFullContent: true,
      });

      assert.equal(readBack.mode, 'history-read');
      assert.equal(readBack.count, 1);
      assert.match(readBack.messages[0].content, /Spring Break from 2026-04-06 through 2026-04-10/);
    } finally {
      store.close();
    }
  });
});

await test('MemoryManager runs the sidekick distiller asynchronously and persists corrections', async () => {
  await withTempStore('sidekick-distillation', async (_dir, dbPath) => {
    let distillerCalls = 0;
    const manager = new MemoryManager({
      dbPath,
      distillationThresholdTokens: 10,
      async distiller(request) {
        distillerCalls++;
        assert.ok(request.messages.length >= 2);
        return {
          summary: 'Saved one Canva correction.',
          memories: [
            {
              scope: 'site',
              subject: 'canva',
              summary: 'Uploads are in the left sidebar Uploads panel.',
              details: 'Later testing corrected the older Apps-only belief.',
              tags: ['canva', 'uploads'],
              supersedesMemoryIds: request.memorySnapshot.map((memory) => memory.id),
              invalidationReason: 'Fresh walkthrough contradicted the old memory.',
            },
          ],
        };
      },
    });

    try {
      const oldMemory = manager.saveMemory({
        scope: 'site',
        subject: 'canva',
        summary: 'Uploads are under Apps.',
        details: 'Older observation from a previous session.',
        tags: ['canva', 'uploads'],
      });

      manager.recordConversationTurn([
        { role: 'user', content: 'Open Canva and find uploads.', tokenEstimate: 6, source: 'user-command' },
        { role: 'assistant', content: 'Uploads are actually in the left sidebar, not Apps.', tokenEstimate: 7, source: 'assistant-response' },
      ]);

      manager.maybeScheduleDistillation();
      await manager.flushSidekick();

      assert.equal(distillerCalls, 1);
      const status = manager.getSidekickStatus();
      assert.equal(status.state, 'idle');
      assert.equal(status.lastSavedCount, 1);
      assert.match(status.lastSummary, /Saved one Canva correction/);

      const active = manager.queryMemory({ query: 'canva uploads', includeFullDetails: true, limit: 5 });
      assert.equal(active.count, 1);
      assert.equal(active.memories[0].status, 'active');
      assert.notEqual(active.memories[0].id, oldMemory.memoryId);

      const old = manager.queryMemory({ memoryIds: [oldMemory.memoryId], includeFullDetails: true }).memories[0];
      assert.equal(old.status, 'superseded');
    } finally {
      manager.close();
    }
  });
});

await test('MemoryManager can prioritize distillation for substantial answers below the normal threshold', async () => {
  await withTempStore('priority-distillation', async (_dir, dbPath) => {
    let distillerCalls = 0;
    const manager = new MemoryManager({
      dbPath,
      distillationThresholdTokens: 500,
      async distiller(request) {
        distillerCalls++;
        assert.equal(request.messages.length, 2);
        return {
          summary: 'Saved one school calendar finding.',
          memories: [
            {
              scope: 'general',
              subject: 'Tyee Middle School calendar',
              summary: 'Tyee Middle School follows BSD 405 no-school dates unless the school posts an exception.',
              details: 'Key retrieval anchors: Tyee Middle School, BSD 405, Bellevue School District, holidays, non-school days.',
              tags: ['tyee', 'bsd405', 'calendar', 'holidays'],
            },
          ],
        };
      },
    });

    try {
      manager.recordConversationTurn([
        { role: 'user', content: 'What are the Tyee Middle School holidays?', tokenEstimate: 10, source: 'user-command' },
        {
          role: 'assistant',
          content: 'Tyee Middle School follows BSD 405 no-school dates unless the school posts an exception. Upcoming district closures include 2026-03-27 and Spring Break from 2026-04-06 through 2026-04-10.',
          tokenEstimate: 40,
          source: 'assistant-response',
        },
      ]);

      manager.requestPriorityDistillation('substantial-assistant-finding');
      await manager.flushSidekick();

      assert.equal(distillerCalls, 1);
      const saved = manager.queryMemory({ query: 'Tyee Middle School holidays', includeFullDetails: true, limit: 5 });
      assert.equal(saved.count, 1);
      assert.equal(saved.memories[0].subject, 'Tyee Middle School calendar');
    } finally {
      manager.close();
    }
  });
});

await test('MemoryManager defers sidekick startup and emits operation events for scheduling and persistence', async () => {
  await withTempStore('sidekick-deferred-start', async (_dir, dbPath) => {
    const operationEvents = [];
    let distillerStarted = false;
    const manager = new MemoryManager({
      dbPath,
      distillationThresholdTokens: 5,
      async distiller() {
        distillerStarted = true;
        return {
          summary: 'Saved one preference.',
          memories: [
            {
              scope: 'user',
              subject: 'response style',
              summary: 'The user prefers concise updates.',
              tags: ['user', 'style'],
            },
          ],
        };
      },
    });

    manager.on('operation', (event) => {
      operationEvents.push(event);
    });

    try {
      manager.recordConversationTurn([
        { role: 'user', content: 'Keep updates concise.', tokenEstimate: 3, source: 'user-command' },
        { role: 'assistant', content: 'I will keep updates concise.', tokenEstimate: 4, source: 'assistant-response' },
      ]);

      manager.maybeScheduleDistillation();

      assert.equal(distillerStarted, false);
      assert.equal(manager.getSidekickStatus().state, 'pending');
      assert.ok(operationEvents.some((event) => event.category === 'distillation' && event.action === 'scheduled'));

      await manager.flushSidekick();

      assert.equal(distillerStarted, true);
      assert.ok(operationEvents.some((event) => event.category === 'distillation' && event.action === 'started'));
      assert.ok(operationEvents.some((event) => event.category === 'memory' && event.action === 'saved'));
      assert.ok(operationEvents.some((event) => event.category === 'distillation' && event.action === 'completed'));
    } finally {
      manager.close();
    }
  });
});

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
