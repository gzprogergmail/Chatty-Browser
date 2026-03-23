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

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
