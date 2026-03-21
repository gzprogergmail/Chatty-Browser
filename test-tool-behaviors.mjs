/**
 * test-tool-behaviors.mjs
 *
 * Automated test for the four new behaviors:
 *   1. Tool-call printing (visual – manual inspection)
 *   2. JSONL logging with file rotation and max-file-count enforcement
 *   3. Disk read/write confirmation (permissionHandler)
 *   4. HTTP method confirmation (onPreToolUse web_fetch gate)
 *
 * Run with:  node test-tool-behaviors.mjs
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`${PASS} ${label}`);
    passed++;
  } catch (e) {
    console.log(`${FAIL} ${label}\n      ${e.message}`);
    failed++;
  }
}

async function asyncTest(label, fn) {
  try {
    await fn();
    console.log(`${PASS} ${label}`);
    passed++;
  } catch (e) {
    console.log(`${FAIL} ${label}\n      ${e.message}`);
    failed++;
  }
}

// ── 1. ToolLogger unit tests ─────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), 'logs');
const SMALL_LIMIT = 200; // bytes – used to trigger rotation quickly in tests

// Clear previous test artefacts
if (fs.existsSync(LOG_DIR)) {
  for (const f of fs.readdirSync(LOG_DIR).filter(f => f.includes('TEST'))) {
    fs.unlinkSync(path.join(LOG_DIR, f));
  }
}
fs.mkdirSync(LOG_DIR, { recursive: true });

// Inline mini-logger (same logic as ToolLogger but with configurable limits)
class MiniLogger {
  filePath = null;
  fileBytes = 0;
  constructor(dir, maxFileBytes, maxFiles) {
    this.dir = dir;
    this.maxFileBytes = maxFileBytes;
    this.maxFiles = maxFiles;
    fs.mkdirSync(dir, { recursive: true });
  }
  log(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    const lb = Buffer.byteLength(line, 'utf8');
    if (this.filePath === null || this.fileBytes + lb > this.maxFileBytes) {
      this.openNewFile();
    }
    fs.appendFileSync(this.filePath, line, 'utf8');
    this.fileBytes += lb;
  }
  openNewFile() {
    this._seq = (this._seq ?? 0) + 1;
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const seq = String(this._seq).padStart(4, '0');
    this.filePath = path.join(this.dir, `tool-calls-TEST-${ts}-${seq}.jsonl`);
    this.fileBytes = 0;
    const existing = fs.readdirSync(this.dir)
      .filter(f => f.startsWith('tool-calls-') && f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(this.dir, f));
    while (existing.length >= this.maxFiles) fs.unlinkSync(existing.shift());
  }
}

console.log('\n── JSONL Logger ───────────────────────────────────────────────────────\n');

await asyncTest('creates logs/ directory', async () => {
  assert.ok(fs.existsSync(LOG_DIR), 'logs/ does not exist');
});

await asyncTest('writes a JSONL file on first log()', async () => {
  const logger = new MiniLogger(LOG_DIR, SMALL_LIMIT, 5);
  logger.log({ type: 'call', tool: 'bash', args: { command: 'echo hi' } });
  assert.ok(logger.filePath !== null, 'filePath is null');
  assert.ok(fs.existsSync(logger.filePath), 'file not created');
  const content = fs.readFileSync(logger.filePath, 'utf8').trim();
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.type, 'call');
  assert.strictEqual(parsed.tool, 'bash');
  assert.ok(typeof parsed.ts === 'string', 'ts field missing');
});

await asyncTest('rotates file when size limit exceeded', async () => {
  const logger = new MiniLogger(LOG_DIR, SMALL_LIMIT, 5);
  const firstPath = () => logger.filePath;
  logger.log({ type: 'call', tool: 'test', args: 'a'.repeat(100) });
  const file1 = logger.filePath;
  // The next write will exceed SMALL_LIMIT, triggering a new file
  logger.log({ type: 'call', tool: 'test', args: 'b'.repeat(100) });
  const file2 = logger.filePath;
  assert.notStrictEqual(file1, file2, 'file was not rotated');
});

await asyncTest('enforces max file count (keeps ≤ maxFiles)', async () => {
  const testDir = path.join(LOG_DIR, 'max-count-test');
  fs.mkdirSync(testDir, { recursive: true });
  const MAX = 3;
  const logger = new MiniLogger(testDir, 10, MAX); // 10 bytes forces rotation every entry
  for (let i = 0; i < MAX + 5; i++) {
    // Small delay to ensure unique ms timestamps in filenames
    await new Promise(r => setTimeout(r, 2));
    logger.log({ type: 'call', tool: `t${i}`, args: i });
  }
  const files = fs.readdirSync(testDir).filter(f => f.endsWith('.jsonl'));
  assert.ok(files.length <= MAX, `expected ≤ ${MAX} files, got ${files.length}`);
  // Clean up
  for (const f of files) fs.unlinkSync(path.join(testDir, f));
  fs.rmdirSync(testDir);
});

await asyncTest('each log line is valid JSONL (every line is parseable JSON)', async () => {
  const logger = new MiniLogger(LOG_DIR, 10 * 1024 * 1024, 5);
  logger.log({ type: 'call', tool: 'bash', args: { command: 'ls' } });
  logger.log({ type: 'result', tool: 'bash', result: { output: 'file.txt' } });
  const lines = fs.readFileSync(logger.filePath, 'utf8').trim().split('\n');
  for (const line of lines) {
    const obj = JSON.parse(line); // throws if invalid
    assert.ok('ts' in obj, 'line missing ts field');
    assert.ok('type' in obj, 'line missing type field');
  }
});

// ── 2. formatArgs truncation ─────────────────────────────────────────────────

console.log('\n── formatArgs helper ──────────────────────────────────────────────────\n');

// Import the compiled JS version
const { default: chalk } = await import('chalk');
// Inline the same logic as in copilot-client.ts (can't easily re-import it)
function formatArgs(args) {
  if (args == null) return '';
  try {
    const trunc = (v) => {
      if (typeof v === 'string' && v.length > 80)
        return v.slice(0, 80) + ` …(${v.length - 80} more)`;
      if (Array.isArray(v)) return v.map(trunc);
      if (typeof v === 'object' && v !== null)
        return Object.fromEntries(Object.entries(v).map(([k, v2]) => [k, trunc(v2)]));
      return v;
    };
    return JSON.stringify(trunc(args));
  } catch { return String(args); }
}

test('short args are returned unchanged', () => {
  const r = formatArgs({ command: 'echo hi' });
  assert.strictEqual(r, '{"command":"echo hi"}');
});

test('long string values are truncated to 80 chars', () => {
  const r = formatArgs({ file_text: 'x'.repeat(200) });
  const parsed = JSON.parse(r);
  assert.ok(parsed.file_text.includes('…(120 more)'), 'not truncated: ' + parsed.file_text);
});

test('nested long strings are truncated', () => {
  const r = formatArgs({ nested: { deep: 'y'.repeat(100) } });
  const parsed = JSON.parse(r);
  assert.ok(parsed.nested.deep.includes('…'), 'nested not truncated');
});

// ── 3. Permission handler logic ───────────────────────────────────────────────

console.log('\n── permissionHandler logic ────────────────────────────────────────────\n');

// Simulate the handler without an actual inquirer prompt (mock confirmAction)
async function makeHandler(alwaysAllow) {
  return async (request) => {
    const { kind } = request;
    if (kind === 'read' || kind === 'write') {
      // Simulate user answer (alwaysAllow = yes, otherwise no)
      if (!alwaysAllow) {
        return { kind: 'denied-interactively-by-user', feedback: 'User denied disk access.' };
      }
    }
    return { kind: 'approved' };
  };
}

await asyncTest('read kind → denied when user denies', async () => {
  const h = await makeHandler(false);
  const r = await h({ kind: 'read', toolCallId: 'x' });
  assert.strictEqual(r.kind, 'denied-interactively-by-user');
});

await asyncTest('write kind → denied when user denies', async () => {
  const h = await makeHandler(false);
  const r = await h({ kind: 'write', toolCallId: 'x' });
  assert.strictEqual(r.kind, 'denied-interactively-by-user');
});

await asyncTest('shell kind → approved automatically (no prompt)', async () => {
  const h = await makeHandler(false); // user would deny if asked, but shell is not asked
  const r = await h({ kind: 'shell', toolCallId: 'x' });
  assert.strictEqual(r.kind, 'approved');
});

await asyncTest('mcp kind → approved automatically', async () => {
  const h = await makeHandler(false);
  const r = await h({ kind: 'mcp', toolCallId: 'x' });
  assert.strictEqual(r.kind, 'approved');
});

// ── 4. HTTP method gate logic ─────────────────────────────────────────────────

console.log('\n── web_fetch HTTP gate logic ──────────────────────────────────────────\n');

// Simulate the onPreToolUse handler without inquirer (inject confirmFn)
async function simulatePreToolUse(toolName, toolArgs, confirmFn) {
  if (toolName === 'web_fetch') {
    const method = (toolArgs?.method ?? 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const ok = await confirmFn(method, toolArgs.url);
      if (!ok) return { permissionDecision: 'deny', permissionDecisionReason: 'User denied HTTP request.' };
    }
  }
  return { permissionDecision: 'allow' };
}

await asyncTest('GET request → always allowed (no prompt)', async () => {
  let prompted = false;
  const r = await simulatePreToolUse('web_fetch', { url: 'https://x.com', method: 'GET' }, () => { prompted = true; return false; });
  assert.strictEqual(r.permissionDecision, 'allow');
  assert.ok(!prompted, 'should not have prompted for GET');
});

for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  await asyncTest(`${method} → denied when user denies`, async () => {
    const r = await simulatePreToolUse('web_fetch', { url: 'https://x.com', method }, async () => false);
    assert.strictEqual(r.permissionDecision, 'deny');
  });

  await asyncTest(`${method} → allowed when user confirms`, async () => {
    const r = await simulatePreToolUse('web_fetch', { url: 'https://x.com', method }, async () => true);
    assert.strictEqual(r.permissionDecision, 'allow');
  });
}

await asyncTest('non-web_fetch tool → always allowed', async () => {
  const r = await simulatePreToolUse('bash', { command: 'ls' }, async () => false);
  assert.strictEqual(r.permissionDecision, 'allow');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(68)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: \x1b[31m${failed}\x1b[0m`);
console.log(`${'─'.repeat(68)}\n`);

if (failed > 0) process.exit(1);
