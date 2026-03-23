import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserAgent } from './dist/agent/browser-agent.js';
import { MemoryStore } from './dist/memory/memory-store.js';

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
  const dir = path.join(process.cwd(), 'test-artifacts', label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const store = new MemoryStore(path.join(dir, 'memory.sqlite'));

  try {
    return await fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── Memory Tests ───────────────────────────────────────────────────────\n');

await test('save_memory creates a reusable memory record', async () => {
  await withTempStore('save-memory-create', async (store, dir) => {
    const result = await store.callTool('save_memory', {
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
  });
});

await test('save_memory updates an existing record instead of duplicating it', async () => {
  await withTempStore('save-memory-update', async (store) => {
    const first = await store.callTool('save_memory', {
      scope: 'site',
      subject: 'canva',
      summary: 'Canva uploads live in the left sidebar.',
      details: 'Open Uploads from the left rail.',
      tags: ['canva'],
      confidence: 0.7,
    });

    const second = await store.callTool('save_memory', {
      scope: 'site',
      subject: 'canva',
      summary: 'Canva uploads live in the left sidebar.',
      details: 'Open Uploads from the left rail, then drag files into the editor.',
      tags: ['canva', 'uploads'],
      confidence: 0.95,
    });

    const query = await store.callTool('query_memory', { query: 'canva uploads', includeFullDetails: true, limit: 5 });
    assert.equal(first.memoryId, second.memoryId);
    assert.equal(second.status, 'updated');
    assert.equal(query.count, 1);
    assert.match(query.memories[0].details, /drag files into the editor/);
    assert.deepStrictEqual(query.memories[0].tags, ['canva', 'uploads']);
  });
});

await test('query_memory combines structured filters and text search', async () => {
  await withTempStore('query-memory-search', async (store) => {
    await store.callTool('save_memory', {
      scope: 'site',
      subject: 'canva',
      summary: 'Brand kit is in the left sidebar.',
      details: 'Use the Brand panel in the editor sidebar.',
      tags: ['canva', 'brand'],
    });
    await store.callTool('save_memory', {
      scope: 'workflow',
      subject: 'invoice export',
      summary: 'Export invoices as PDF after previewing totals.',
      details: 'Verify totals before exporting.',
      tags: ['invoice', 'pdf'],
    });

    const result = await store.callTool('query_memory', {
      query: 'brand sidebar',
      scope: 'site',
      subject: 'canva',
      tags: ['brand'],
      limit: 5,
    });

    assert.equal(result.mode, 'search');
    assert.equal(result.count, 1);
    assert.equal(result.memories[0].subject, 'canva');
    assert.ok(result.memories[0].matchReasons.includes('fts') || result.memories[0].matchReasons.includes('text'));
    assert.ok(typeof result.memories[0].detailsSnippet === 'string');
  });
});

await test('query_memory can read full records by ID after a short search result', async () => {
  await withTempStore('query-memory-read', async (store) => {
    const saved = await store.callTool('save_memory', {
      scope: 'site',
      subject: 'github billing',
      summary: 'Billing entity selection is under Copilot billing settings.',
      details: 'Go to Settings > Copilot > Billing to choose the billing entity for premium requests.',
      tags: ['github', 'billing', 'copilot'],
    });

    const result = await store.callTool('query_memory', {
      memoryIds: [saved.memoryId],
    });

    assert.equal(result.mode, 'read');
    assert.equal(result.count, 1);
    assert.match(result.memories[0].details, /Settings > Copilot > Billing/);
  });
});

await test('BrowserAgent.initialize registers memory tools alongside browser tools', async () => {
  const captured = {};
  const copilot = {
    async createSession(tools, callTool, systemPrompt) {
      captured.tools = tools;
      captured.callTool = callTool;
      captured.systemPrompt = systemPrompt;
    },
  };
  const mcp = {
    getTools() {
      return [{
        name: 'browser_navigate',
        description: 'Navigate to a URL.',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      }];
    },
    async callTool(name, args) {
      return { from: 'mcp', name, args };
    },
  };
  const agent = new BrowserAgent(copilot, mcp);

  await agent.initialize();

  const toolNames = captured.tools.map(tool => tool.name);
  assert.ok(toolNames.includes('browser_navigate'));
  assert.ok(toolNames.includes('save_memory'));
  assert.ok(toolNames.includes('query_memory'));
  assert.match(captured.systemPrompt, /long-term memory tools/);

  const memoryResult = await captured.callTool('query_memory', { query: 'canva', limit: 3 });
  assert.equal(memoryResult.mode, 'search');
});

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
