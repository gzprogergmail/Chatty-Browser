# GitHub Copilot Instructions

## Project Overview

Self-Contained Browser Agent — a Node.js CLI application that lets users control a Chromium browser using natural language commands. It uses GitHub Copilot (GPT-4o) as the AI backbone and Playwright via MCP (Model Context Protocol) for browser automation.

## Tech Stack

- **Language**: TypeScript 5, compiled to ESM (`"type": "module"`)
- **Runtime**: Node.js 18+
- **AI**: `@github/copilot-sdk` (official SDK, Infinite Sessions, GPT-4o)
- **Browser automation**: `@playwright/mcp` MCP server + `@modelcontextprotocol/sdk` client
- **CLI**: `inquirer` for prompts, `chalk` for terminal colours
- **HTTP**: `axios` (auth polling only)
- **Build**: `tsc` → `dist/`

## Architecture

```
src/
├── index.ts                    # Entry point — wires all modules together
├── auth/github-auth.ts         # GitHub device-flow OAuth, caches token in .auth-cache.json
├── copilot/
│   ├── copilot-client.ts       # @github/copilot-sdk wrapper; creates/manages CopilotSession
│   └── tool-logger.ts          # JSONL tool-call logger (logs/ directory, 10 MB rotation)
├── mcp/mcp-server-manager.ts   # Spawns @playwright/mcp via StdioClientTransport
├── agent/browser-agent.ts      # Orchestrates copilot + MCP; exposes executeCommand()
└── cli/cli-interface.ts        # Interactive prompt loop with token-usage bar
```

## Key Conventions

### Imports
- Always use `.js` extensions in import paths (TypeScript ESM requirement).
- Use named imports; avoid default imports unless the library only exports one thing.

### TypeScript
- Strict mode is enabled — always type function parameters and return values.
- Prefer `readonly` for class properties that are never reassigned.
- Use `private` for internal class state, not `#` private fields.
- Avoid `any` except for MCP tool `inputSchema` (third-party JSON Schema objects).

### Error handling
- Throw `Error` objects with descriptive messages; catch at the CLI boundary.
- Wrap external calls (MCP, Copilot SDK, Axios) in try/catch and re-throw with context.

### Async
- All I/O is `async/await`; never use callbacks or raw `.then()` chains.
- Top-level `main()` is an async IIFE called at the bottom of `index.ts`.

### Logging / UI
- Use `chalk` for all terminal colouring; keep a consistent colour scheme:
  - `chalk.cyan` — step headers
  - `chalk.green` — success
  - `chalk.red` — errors
  - `chalk.gray` — debug / secondary info
  - `chalk.yellow` — warnings / special actions
- Tool call display lives in `copilot-client.ts` (`toolLabel`, `formatArgs`).
- Log structured tool-call data via `toolLogger` (never `console.log` for tool events).

### MCP Tools
- Tools are fetched from the MCP server at runtime — do not hardcode tool names.
- Pass raw tool results (including base64 screenshots) through to the model unchanged.
- `MCPToolDef` is the shared interface for tool definitions passed between modules.

## Build & Run

```bash
npm run build      # tsc → dist/
npm start          # production
npm run dev        # build + start in one step
npm test           # component tests (test-components.js)
node integration-test.js  # integration tests (requires auth)
npm run demo       # mock demo mode (no auth needed)
```

## Adding a New Feature

1. If it touches browser behaviour, add/adjust tools in `mcp/mcp-server-manager.ts`.
2. If it touches the AI conversation, modify `agent/browser-agent.ts` (system prompt, session options).
3. If it's a new CLI command, add a branch in the `CLIInterface` loop (`cli/cli-interface.ts`).
4. Re-export no public API — this is a CLI app, not a library.

## Security Notes

- The GitHub OAuth token is cached in `.auth-cache.json` (gitignored). Never log or expose it.
- Disk read/write operations require explicit user confirmation via `permissionHandler` in `copilot-client.ts`.
- Do not add new network calls outside of `github-auth.ts` and the Copilot SDK — all browser I/O goes through MCP.
- Validate any user-supplied input before passing it to shell commands or file paths.

## Files to Ignore

- `dist/` — compiled output, never edit directly
- `logs/` — runtime tool-call logs, auto-rotated
- `.auth-cache.json` — cached OAuth token
- `node_modules/`
