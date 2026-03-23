import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserAgent } from './dist/agent/browser-agent.js';
import { MemoryManager } from './dist/memory/memory-store.js';

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

async function withTempManager(label, fn) {
  const dir = path.join(process.cwd(), 'test-artifacts', label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.sqlite');
  const manager = new MemoryManager({ dbPath, distillationThresholdTokens: 1 });

  try {
    return await fn(manager, dir);
  } finally {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── App Memory Integration Tests ───────────────────────────────────────\n');

await test('BrowserAgent.initialize registers package memory tools alongside browser tools', async () => {
  await withTempManager('browser-agent-init', async (memoryManager) => {
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
    const agent = new BrowserAgent(copilot, mcp, { memoryManager });

    await agent.initialize();

    const toolNames = captured.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('browser_navigate'));
    assert.ok(toolNames.includes('save_memory'));
    assert.ok(toolNames.includes('query_memory'));
    assert.match(captured.systemPrompt, /mark the older memory IDs as superseded or invalidated/);

    const memoryResult = await captured.callTool('query_memory', { query: 'canva', limit: 3 });
    assert.equal(memoryResult.mode, 'search');
  });
});

await test('BrowserAgent routes browser tools to MCP and memory tools to the package manager', async () => {
  await withTempManager('browser-agent-routing', async (memoryManager) => {
    const captured = {};
    const copilot = {
      async createSession(_tools, callTool) {
        captured.callTool = callTool;
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
    const agent = new BrowserAgent(copilot, mcp, { memoryManager });
    await agent.initialize();

    const memoryResult = await captured.callTool('save_memory', {
      scope: 'site',
      subject: 'canva',
      summary: 'Uploads are in the left sidebar.',
    });
    const browserResult = await captured.callTool('browser_navigate', { url: 'https://example.com' });

    assert.equal(memoryResult.subject, 'canva');
    assert.deepStrictEqual(browserResult, {
      from: 'mcp',
      name: 'browser_navigate',
      args: { url: 'https://example.com' },
    });
  });
});

await test('BrowserAgent records turns and exposes sidekick status from the package manager', async () => {
  const dir = path.join(process.cwd(), 'test-artifacts', 'browser-agent-sidekick');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.sqlite');

  let distillerCalls = 0;
  const memoryManager = new MemoryManager({
    dbPath,
    distillationThresholdTokens: 1,
    async distiller(request) {
      distillerCalls++;
      return {
        summary: 'Saved one durable preference.',
        memories: [{
          scope: 'user',
          subject: 'user preference',
          summary: 'The user prefers concise answers.',
          details: `Distilled from ${request.messages.length} messages.`,
          tags: ['user', 'preference'],
        }],
      };
    },
  });

  try {
    const copilot = {
      async sendMessage(command) {
        assert.equal(command, 'remember this');
        return 'I will keep that in mind.';
      },
      didStreamLastTurn() {
        return false;
      },
    };
    const mcp = {
      getTools() {
        return [];
      },
      async callTool() {
        throw new Error('MCP should not be called in this test');
      },
    };
    const agent = new BrowserAgent(copilot, mcp, { memoryManager });

    const response = await agent.executeCommand('remember this');
    await agent.flushMemorySidekick();

    assert.equal(response, 'I will keep that in mind.');
    assert.equal(distillerCalls, 1);

    const status = agent.getMemorySidekickStatus();
    assert.equal(status.state, 'idle');
    assert.match(status.lastSummary, /Saved one durable preference/);

    const memories = memoryManager.queryMemory({ query: 'concise answers', includeFullDetails: true, limit: 5 });
    assert.equal(memories.count, 1);
    assert.equal(memories.memories[0].subject, 'user preference');
  } finally {
    memoryManager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
