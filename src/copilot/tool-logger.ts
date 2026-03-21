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
const MAX_FILES = 10;                    // oldest files are deleted beyond this

export type ToolLogType = 'call' | 'result';

export interface ToolLogEntry {
  ts: string;
  type: ToolLogType;
  tool: string;
  args?: unknown;
  result?: unknown;
}

class ToolLogger {
  private filePath: string | null = null;
  private fileBytes = 0;

  constructor() {
    // Create the logs directory up-front so it exists before the first write.
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  log(entry: Omit<ToolLogEntry, 'ts'>): void {
    const full: ToolLogEntry = { ts: new Date().toISOString(), ...entry };
    const line = JSON.stringify(full) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    // Rotate when no file is open yet or the current one would exceed 10 MB.
    if (this.filePath === null || this.fileBytes + lineBytes > MAX_FILE_BYTES) {
      this.openNewFile();
    }

    fs.appendFileSync(this.filePath!, line, 'utf8');
    this.fileBytes += lineBytes;
  }

  private openNewFile(): void {
    // Use ISO timestamp in the filename; replace chars that are illegal on Windows.
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    this.filePath = path.join(LOG_DIR, `tool-calls-${ts}.jsonl`);
    this.fileBytes = 0;

    // Prune the oldest files so the total count stays at or below MAX_FILES.
    // We read the list *before* the new file is created so we don't count it.
    const existing = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('tool-calls-') && f.endsWith('.jsonl'))
      .sort()                                   // ISO timestamps sort lexicographically
      .map(f => path.join(LOG_DIR, f));

    while (existing.length >= MAX_FILES) {
      fs.unlinkSync(existing.shift()!);
    }
  }

  /** Return the path of the file currently being written to (for tests). */
  get currentFilePath(): string | null {
    return this.filePath;
  }
}

export const toolLogger = new ToolLogger();
