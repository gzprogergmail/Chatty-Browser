import assert from 'node:assert/strict';
import inquirer from 'inquirer';
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
  const originalLog = console.log;
  const originalError = console.error;
  const originalClear = console.clear;

  console.log = (...args) => logs.push(stripAnsi(args.join(' ')));
  console.error = (...args) => errors.push(stripAnsi(args.join(' ')));
  console.clear = () => {};

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.clear = originalClear;
  }

  return {
    logs,
    errors,
    output: [...logs, ...errors].join('\n'),
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

await test('CLI help text lists the new /usage command', async () => {
  const cli = new CLIInterface({});
  const { output } = await captureConsole(async () => {
    cli.showHelp();
  });

  assert.match(output, /\/usage - Show remaining Copilot premium requests allowance/);
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

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) {
  process.exit(1);
}
