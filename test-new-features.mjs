import assert from 'node:assert/strict';
import inquirer from 'inquirer';
import { BrowserAgent } from './dist/agent/browser-agent.js';
import { CLIInterface } from './dist/cli/cli-interface.js';
import { CopilotClient } from './dist/copilot/copilot-client.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let passed = 0;
let failed = 0;

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function logPass(label) {
  console.log(`${PASS} ${label}`);
  passed++;
}

function logFail(label, error) {
  console.log(`${FAIL} ${label}\n      ${formatError(error)}`);
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

async function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const writes = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalClear = console.clear;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  console.log = (...args) => logs.push(stripAnsi(args.join(' ')));
  console.error = (...args) => errors.push(stripAnsi(args.join(' ')));
  console.clear = () => {};
  process.stdout.write = (chunk, encoding, callback) => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString(typeof encoding === 'string' ? encoding : undefined);
    writes.push(stripAnsi(value));

    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }

    return true;
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.clear = originalClear;
    process.stdout.write = originalStdoutWrite;
  }

  return {
    logs,
    errors,
    writes,
    output: [...logs, ...writes, ...errors].join('\n'),
  };
}

async function withPromptMock(sequence, fn) {
  const originalPrompt = inquirer.prompt;
  let index = 0;

  inquirer.prompt = async () => {
    if (index >= sequence.length) {
      throw { isTtyError: true };
    }

    const next = sequence[index++];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    throw next;
  };

  try {
    return await fn();
  } finally {
    inquirer.prompt = originalPrompt;
  }
}

console.log('\n── New Feature Regression Tests ───────────────────────────────────────\n');

await test('CopilotClient defaults to gpt-5-mini', async () => {
  const client = new CopilotClient();
  assert.equal(client.model, 'gpt-5-mini');
});

await test('CopilotClient creates SDK sessions with streaming enabled', async () => {
  const client = new CopilotClient();
  const captured = {};
  client.sdkClient = {
    async createSession(config) {
      captured.config = config;
      return {
        sessionId: 'session-1',
        on() {
          return () => {};
        },
      };
    },
  };

  await client.createSession([], async () => ({}), 'system prompt');

  assert.equal(captured.config.streaming, true);
});

await test('CopilotClient token usage snapshot includes active model and reasoning', async () => {
  const client = new CopilotClient();
  client.model = 'gpt-5.4';
  client.reasoningEffort = 'high';
  client.sdkCurrentTokens = 1234;
  client.sdkTokenLimit = 8192;
  client.compacting = true;

  assert.deepStrictEqual(client.getTokenUsage(), {
    model: 'gpt-5.4 (high)',
    used: 1234,
    max: 8192,
    compacting: true,
  });
});

await test('CopilotClient context usage line prints the model name', async () => {
  const client = new CopilotClient();
  client.model = 'gpt-4.1';
  client.reasoningEffort = 'medium';
  client.sdkCurrentTokens = 512;
  client.sdkTokenLimit = 2048;
  client.sdkMessagesLength = 4;

  const line = stripAnsi(client.formatTokenUsageLine('Context'));
  assert.match(line, /Context \[gpt-4\.1 \(medium\)\]: ~512 \/ 2,048 tokens \(25\.0%, 4 msgs\)/);
});

await test('CopilotClient turn timeout can be updated and validated', async () => {
  const client = new CopilotClient();

  assert.equal(client.getTurnTimeoutMs(), 300_000);
  assert.equal(client.setTurnTimeoutMs(90_000), 90_000);
  assert.equal(client.getTurnTimeoutMs(), 90_000);
  assert.throws(() => client.setTurnTimeoutMs(999), /at least 1000 ms/);
});

await test('CopilotClient streams reasoning and response chunks during a turn', async () => {
  const client = new CopilotClient();
  const handlers = new Map();

  const emit = (eventType, data) => {
    for (const handler of handlers.get(eventType) ?? []) {
      handler({ type: eventType, data });
    }
  };

  client.session = {
    on(eventType, handler) {
      if (!handlers.has(eventType)) {
        handlers.set(eventType, new Set());
      }
      handlers.get(eventType).add(handler);
      return () => handlers.get(eventType).delete(handler);
    },
    async sendAndWait({ prompt }, timeoutMs) {
      assert.equal(prompt, 'hello');
      assert.equal(timeoutMs, 300_000);
      emit('assistant.reasoning_delta', { deltaContent: 'Thinking step 1. ' });
      emit('assistant.reasoning_delta', { deltaContent: 'Thinking step 2.' });
      emit('assistant.message_delta', { deltaContent: 'Final answer.' });
      return { data: { content: 'Final answer.' } };
    },
  };

  const { output } = await captureConsole(async () => {
    const response = await client.sendMessage('hello');
    assert.equal(response, 'Final answer.');
  });

  assert.equal(client.didStreamLastTurn(), true);
  assert.match(output, /Thinking:/);
  assert.match(output, /Thinking step 1\./);
  assert.match(output, /Thinking step 2\./);
  assert.match(output, /Response:/);
  assert.match(output, /Final answer\./);
});

await test('CopilotClient still shows visible thinking and final response when delta events are missing', async () => {
  const client = new CopilotClient();
  const handlers = new Map();

  const emit = (eventType, data) => {
    for (const handler of handlers.get(eventType) ?? []) {
      handler({ type: eventType, data });
    }
  };

  client.session = {
    on(eventType, handler) {
      if (!handlers.has(eventType)) {
        handlers.set(eventType, new Set());
      }
      handlers.get(eventType).add(handler);
      return () => handlers.get(eventType).delete(handler);
    },
    async sendAndWait({ prompt }, timeoutMs) {
      assert.equal(prompt, 'fallback please');
      assert.equal(timeoutMs, 300_000);
      emit('assistant.turn_start', { turnId: 'turn-1' });
      emit('assistant.message', { content: 'Final answer without delta.', toolRequests: [{ id: 'tool-1' }] });
      return { data: { content: 'Final answer without delta.' } };
    },
  };

  const { output } = await captureConsole(async () => {
    const response = await client.sendMessage('fallback please');
    assert.equal(response, 'Final answer without delta.');
  });

  assert.equal(client.didStreamLastTurn(), true);
  assert.match(output, /Thinking:/);
  assert.match(output, /Response:/);
  assert.match(output, /Final answer without delta\./);
});

await test('CopilotClient premium usage prefers the premium_interactions quota', async () => {
  const client = new CopilotClient();
  client.sdkClient = {
    rpc: {
      account: {
        getQuota: async () => ({
          quotaSnapshots: {
            chat: {
              entitlementRequests: 999,
              usedRequests: 10,
              remainingPercentage: 0.99,
              overage: 0,
              overageAllowedWithExhaustedQuota: true,
            },
            premium_interactions: {
              entitlementRequests: 100,
              usedRequests: 35,
              remainingPercentage: 0.65,
              overage: 2,
              overageAllowedWithExhaustedQuota: false,
              resetDate: '2026-04-01T00:00:00.000Z',
            },
          },
        }),
      },
    },
  };

  const usage = await client.getPremiumRequestsUsage();
  assert.deepStrictEqual(usage, {
    quotaName: 'premium_interactions',
    entitlementRequests: 100,
    usedRequests: 35,
    remainingRequests: 65,
    remainingPercentage: 0.65,
    overage: 2,
    overageAllowedWithExhaustedQuota: false,
    resetDate: '2026-04-01T00:00:00.000Z',
  });
});

await test('CopilotClient premium usage falls back to another premium-named quota', async () => {
  const client = new CopilotClient();
  client.sdkClient = {
    rpc: {
      account: {
        getQuota: async () => ({
          quotaSnapshots: {
            premium_requests: {
              entitlementRequests: 50,
              usedRequests: 10,
              remainingPercentage: 0.8,
              overage: 1,
              overageAllowedWithExhaustedQuota: true,
            },
          },
        }),
      },
    },
  };

  const usage = await client.getPremiumRequestsUsage();
  assert.equal(usage.quotaName, 'premium_requests');
  assert.equal(usage.remainingRequests, 40);
});

await test('CopilotClient premium usage throws when Copilot returns no premium quota', async () => {
  const client = new CopilotClient();
  client.sdkClient = {
    rpc: {
      account: {
        getQuota: async () => ({
          quotaSnapshots: {
            chat: {
              entitlementRequests: 100,
              usedRequests: 20,
              remainingPercentage: 0.8,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        }),
      },
    },
  };

  await assert.rejects(
    () => client.getPremiumRequestsUsage(),
    /did not return a premium request quota snapshot/,
  );
});

await test('BrowserAgent system prompt prefers autonomous research and default browser opening', async () => {
  const agent = new BrowserAgent({}, {});
  const prompt = agent.systemPrompt;

  assert.match(prompt, /Take initiative and try to complete the user's goal end-to-end/);
  assert.match(prompt, /Prefer doing web research in the browser to resolve missing details/);
  assert.match(prompt, /If the user asks to open something, default to opening it in the browser/);
  assert.match(prompt, /use the browser to research it, make the best-supported guess/);
  assert.match(prompt, /mark the older memory IDs as superseded or invalidated/);
  assert.match(prompt, /Relevant memory context/);
  assert.match(prompt, /queries array with up to 5 alternate phrasings/);
  assert.match(prompt, /vary your wording creatively instead of repeating the same terms/);
  assert.match(prompt, /full name vs acronym/);
  assert.match(prompt, /deep_search_history/);
  assert.match(prompt, /search deeper, search further, or search the whole history/);
});

await test('CLI help text lists the memory and usage commands', async () => {
  const cli = new CLIInterface({});
  const { output } = await captureConsole(async () => {
    cli.showHelp();
  });

  assert.match(output, /\/usage - Show remaining Copilot premium requests allowance/);
  assert.match(output, /\/memory-status - Show the background memory sidekick status/);
  assert.match(output, /\/timeout - Show the current per-turn timeout/);
});

await test('CLI /timeout shows the current turn timeout', async () => {
  const agent = {
    getTurnTimeoutMs() {
      return 300_000;
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/timeout' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Turn timeout is 5m \(300,000 ms\)/);
});

await test('CLI /timeout updates the turn timeout on the fly', async () => {
  let updatedValue = 0;
  const agent = {
    setTurnTimeoutMs(timeoutMs) {
      updatedValue = timeoutMs;
      return timeoutMs;
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/timeout 90s' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.equal(updatedValue, 90_000);
  assert.match(output, /Turn timeout set to 90s \(90,000 ms\)/);
});

await test('CLI /timeout rejects invalid timeout values', async () => {
  const agent = {
    setTurnTimeoutMs() {
      throw new Error('should not be called');
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/timeout nope' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Invalid timeout\. Use values like \/timeout 30000, \/timeout 30s, or \/timeout 5m\./);
});

await test('CLI prints model name alongside token usage after a normal turn', async () => {
  let executed = 0;
  const agent = {
    async executeCommand(command) {
      executed++;
      assert.equal(command, 'hello');
      return 'done';
    },
    getTokenUsage() {
      return { model: 'gpt-5.4', used: 300, max: 1200, compacting: false };
    },
    didStreamLastTurn() {
      return false;
    },
    getMemorySidekickStatus() {
      return { state: 'idle', pendingTokenEstimate: 0, distillationThresholdTokens: 2000, lastSavedCount: 0, rerunQueued: false };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: 'hello' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.equal(executed, 1);
  assert.match(output, /Context \[gpt-5\.4\]: \[[^\]]+\] ~300 \/ 1,200 tokens \(25\.0%\)/);
  assert.match(output, /Memory sidekick: idle \(0 \/ 2,000 pending tokens\)/);
});

await test('CLI does not duplicate the final answer after a streamed turn', async () => {
  const agent = {
    async executeCommand(command) {
      assert.equal(command, 'stream please');
      process.stdout.write('   💭 Thinking:\nAnalyzing...\n');
      process.stdout.write('   🤖 Response:\nDone.\n');
      return 'Done.';
    },
    didStreamLastTurn() {
      return true;
    },
    getTokenUsage() {
      return { model: 'gpt-5-mini', used: 100, max: 1000, compacting: false };
    },
    getMemorySidekickStatus() {
      return { state: 'running', pendingTokenEstimate: 2300, distillationThresholdTokens: 2000, lastSavedCount: 1, lastSummary: 'Saved one item.', rerunQueued: false };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: 'stream please' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Thinking:/);
  assert.match(output, /Response:/);
  assert.doesNotMatch(output, /🤖 Agent: Done\./);
  assert.match(output, /Memory sidekick: running \(2,300 \/ 2,000 pending tokens, last: Saved one item\./);
});

await test('CLI prints lightweight live feedback for background memory work', async () => {
  let statusListener = null;
  const agent = {
    onMemorySidekickStatusChange(listener) {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    },
    async executeCommand(command) {
      assert.equal(command, 'remember this');
      setTimeout(() => {
        statusListener?.({
          state: 'pending',
          pendingTokenEstimate: 2100,
          distillationThresholdTokens: 2000,
          lastSavedCount: 0,
          rerunQueued: false,
        });
      }, 0);
      setTimeout(() => {
        statusListener?.({
          state: 'running',
          pendingTokenEstimate: 2100,
          distillationThresholdTokens: 2000,
          lastSavedCount: 0,
          rerunQueued: false,
        });
      }, 5);
      setTimeout(() => {
        statusListener?.({
          state: 'idle',
          pendingTokenEstimate: 0,
          distillationThresholdTokens: 2000,
          lastSavedCount: 1,
          lastRunAt: '2026-03-23T10:00:00.000Z',
          lastSummary: 'Saved one durable memory.',
          rerunQueued: false,
        });
      }, 10);
      return 'done';
    },
    didStreamLastTurn() {
      return false;
    },
    getTokenUsage() {
      return { model: 'gpt-5-mini', used: 120, max: 1000, compacting: false };
    },
    getMemorySidekickStatus() {
      return {
        state: 'idle',
        pendingTokenEstimate: 0,
        distillationThresholdTokens: 2000,
        lastSavedCount: 1,
        lastRunAt: '2026-03-23T10:00:00.000Z',
        lastSummary: 'Saved one durable memory.',
        rerunQueued: false,
      };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: 'remember this' }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw { isTtyError: true };
      },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Memory sidekick queued in background \(2,100 pending tokens\)\./);
  assert.match(output, /Memory sidekick saving in background\.\.\./);
  assert.match(output, /Memory sidekick finished: Saved one durable memory\./);
});

await test('CLI defers memory sidekick feedback while the user prompt is active', async () => {
  let statusListener = null;
  let resolvePrompt;
  const agent = {
    onMemorySidekickStatusChange(listener) {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    },
    async executeCommand(command) {
      assert.equal(command, 'remember this');
      return 'done';
    },
    didStreamLastTurn() {
      return false;
    },
    getTokenUsage() {
      return { model: 'gpt-5-mini', used: 120, max: 1000, compacting: false };
    },
    getMemorySidekickStatus() {
      return {
        state: 'idle',
        pendingTokenEstimate: 0,
        distillationThresholdTokens: 2000,
        lastSavedCount: 0,
        rerunQueued: false,
      };
    },
  };
  const cli = new CLIInterface(agent);

  const logs = [];
  const errors = [];
  const writes = [];
  const originalPrompt = inquirer.prompt;
  const originalLog = console.log;
  const originalError = console.error;
  const originalClear = console.clear;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let promptCalls = 0;

  console.log = (...args) => logs.push(stripAnsi(args.join(' ')));
  console.error = (...args) => errors.push(stripAnsi(args.join(' ')));
  console.clear = () => {};
  process.stdout.write = (chunk, encoding, callback) => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString(typeof encoding === 'string' ? encoding : undefined);
    writes.push(stripAnsi(value));

    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }

    return true;
  };

  inquirer.prompt = async () => {
    promptCalls++;
    if (promptCalls === 1) {
      return await new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    }

    throw { isTtyError: true };
  };

  try {
    const startPromise = cli.start();
    for (let attempt = 0; attempt < 20 && typeof resolvePrompt !== 'function'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(typeof resolvePrompt, 'function');

    statusListener?.({
      state: 'pending',
      pendingTokenEstimate: 2100,
      distillationThresholdTokens: 2000,
      lastSavedCount: 0,
      rerunQueued: false,
    });
    statusListener?.({
      state: 'running',
      pendingTokenEstimate: 2100,
      distillationThresholdTokens: 2000,
      lastSavedCount: 0,
      rerunQueued: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforePromptResolves = [...logs, ...writes, ...errors].join('\n');
    assert.doesNotMatch(beforePromptResolves, /Memory sidekick queued in background/);
    assert.doesNotMatch(beforePromptResolves, /Memory sidekick saving in background/);

    resolvePrompt({ command: 'remember this' });
    await startPromise;

    const output = [...logs, ...writes, ...errors].join('\n');
    assert.match(output, /Memory sidekick queued in background \(2,100 pending tokens\)\./);
    assert.match(output, /Memory sidekick saving in background\.\.\./);
  } finally {
    inquirer.prompt = originalPrompt;
    console.log = originalLog;
    console.error = originalError;
    console.clear = originalClear;
    process.stdout.write = originalStdoutWrite;
  }
});

await test('CLI /memory-status prints the current sidekick status', async () => {
  const agent = {
    getMemorySidekickStatus() {
      return {
        state: 'pending',
        pendingTokenEstimate: 2100,
        distillationThresholdTokens: 2000,
        lastSavedCount: 2,
        rerunQueued: true,
        lastSummary: 'Saved 2 memories.',
      };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/memory-status' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Memory sidekick: pending \(2,100 \/ 2,000 pending tokens, rerun queued, last: Saved 2 memories\./);
});

await test('CLI /usage command calls the agent and prints the remaining premium allowance', async () => {
  let usageCalls = 0;
  const agent = {
    async getPremiumRequestsUsage() {
      usageCalls++;
      return {
        quotaName: 'premium_interactions',
        entitlementRequests: 100,
        usedRequests: 20,
        remainingRequests: 80,
        remainingPercentage: 0.8,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: '2026-04-01T00:00:00.000Z',
      };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/usage' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.equal(usageCalls, 1);
  assert.match(output, /Copilot Premium Usage/);
  assert.match(output, /Quota: premium_interactions/);
  assert.match(output, /Remaining: 80 \/ 100 requests \(80\.0%\)/);
  assert.match(output, /Used: 20 requests/);
  assert.match(output, /Overage: 0 \(not allowed\)/);
});

await test('CLI /usage computes the displayed percentage from request counts', async () => {
  const agent = {
    async getPremiumRequestsUsage() {
      return {
        quotaName: 'premium_interactions',
        entitlementRequests: 300,
        usedRequests: 203,
        remainingRequests: 97,
        remainingPercentage: 32.4,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: '2026-04-01T00:00:00.000Z',
      };
    },
  };
  const cli = new CLIInterface(agent);

  const { output } = await withPromptMock(
    [
      () => ({ command: '/usage' }),
      { isTtyError: true },
    ],
    () => captureConsole(async () => {
      await cli.start();
    }),
  );

  assert.match(output, /Remaining: 97 \/ 300 requests \(32\.3%\)/);
  assert.doesNotMatch(output, /3240\.0%/);
});

await test('CLI /usage shows the next monthly premium reset date in UTC', async () => {
  const agent = {
    async getPremiumRequestsUsage() {
      return {
        quotaName: 'premium_interactions',
        entitlementRequests: 100,
        usedRequests: 20,
        remainingRequests: 80,
        remainingPercentage: 80,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: '2026-03-23T01:53:50.154Z',
      };
    },
  };
  const cli = new CLIInterface(agent);
  const RealDate = global.Date;

  class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super('2026-03-22T18:48:34.000Z');
        return;
      }

      super(...args);
    }

    static now() {
      return new RealDate('2026-03-22T18:48:34.000Z').getTime();
    }
  }

  global.Date = MockDate;

  let output;
  try {
    ({ output } = await withPromptMock(
      [
        () => ({ command: '/usage' }),
        { isTtyError: true },
      ],
      () => captureConsole(async () => {
        await cli.start();
      }),
    ));
  } finally {
    global.Date = RealDate;
  }
  assert.match(output, /Reset: Apr 1, 2026, 12:00:00 AM UTC/);
});

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
