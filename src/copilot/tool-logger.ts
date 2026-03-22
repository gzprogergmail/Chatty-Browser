import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Logs are written to <project-root>/logs/ regardless of where the CLI is run from.
// At runtime the compiled file sits at dist/copilot/tool-logger.js, so ../../ gets
// us back to the project root.
const LOG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../logs',
);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

// Ensures unique filenames even if two rotations happen in the same millisecond.
let _fileSeq = 0;

export type ToolLogType = 'call' | 'result';

export interface ToolLogEntry {
  ts: string;
  type: ToolLogType;
  tool: string;
  args?: unknown;
  result?: unknown;
}

export interface LLMPayloadLogEntry {
  ts: string;
  direction: 'request' | 'response';
  kind: string;
  payload: unknown;
}

class RotatingJsonlLogger<TEntry extends { ts: string }> {
  private filePath: string | null = null;
  private fileBytes = 0;

  constructor(
    private readonly filePrefix: string,
    private readonly maxFiles: number,
  ) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  log(entry: Omit<TEntry, 'ts'>): void {
    const full = { ts: new Date().toISOString(), ...entry } as TEntry;
    const line = JSON.stringify(full) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    if (this.filePath === null || this.fileBytes + lineBytes > MAX_FILE_BYTES) {
      this.openNewFile();
    }

    fs.appendFileSync(this.filePath!, line, 'utf8');
    this.fileBytes += lineBytes;
  }

  private openNewFile(): void {
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const seq = String(++_fileSeq).padStart(4, '0');
    this.filePath = path.join(LOG_DIR, `${this.filePrefix}-${ts}-${seq}.jsonl`);
    this.fileBytes = 0;

    const existing = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith(`${this.filePrefix}-`) && f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(LOG_DIR, f));

    while (existing.length >= this.maxFiles) {
      fs.unlinkSync(existing.shift()!);
    }
  }

  get currentFilePath(): string | null {
    return this.filePath;
  }
}

class ToolLogger extends RotatingJsonlLogger<ToolLogEntry> {
  constructor() {
    super('tool-calls', 10);
  }
}

class LLMPayloadLogger extends RotatingJsonlLogger<LLMPayloadLogEntry> {
  constructor() {
    super('llm-payloads', 5);
  }
}

export const toolLogger = new ToolLogger();
export const llmPayloadLogger = new LLMPayloadLogger();
