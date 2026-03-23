# Project Structure

## Overview

This is a Node.js/TypeScript application that creates an AI-powered browser automation agent accessible via a command-line interface.

## File Structure

```
SelfContainedAgent/
│
├── src/                          # Source code (TypeScript)
│   ├── index.ts                  # Main entry point - orchestrates all components
│   │
│   ├── auth/                     # Authentication module
│   │   └── github-auth.ts        # GitHub OAuth device flow implementation
│   │
│   ├── copilot/                  # AI/LLM integration
│   │   └── copilot-client.ts     # GitHub Copilot API client with tool calling
│   │
│   ├── mcp/                      # Model Context Protocol
│   │   └── mcp-server-manager.ts # Manages Playwright MCP server lifecycle
│   │
│   ├── agent/                    # Core agent logic
│   │   └── browser-agent.ts      # Orchestrates LLM + MCP tool execution
│   │
│   └── cli/                      # User interface
│       └── cli-interface.ts      # Interactive command-line interface
│
├── dist/                         # Compiled JavaScript (generated)
│
├── package.json                  # Dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── .gitignore                    # Git ignore rules
│
├── README.md                     # Main documentation
├── QUICKSTART.md                 # Quick setup guide
├── EXAMPLES.md                   # Example commands
├── TROUBLESHOOTING.md            # Problem solving guide
├── STRUCTURE.md                  # This file
│
├── setup.bat                     # Windows setup script
└── setup.sh                      # Unix/Mac setup script
```

## Module Details

### `src/index.ts`
**Purpose**: Application entry point
**Responsibilities**:
- Initializes all modules in sequence
- Handles top-level errors
- Provides user feedback during startup
- Coordinates overall flow

### `src/auth/github-auth.ts`
**Purpose**: GitHub authentication
**Key Features**:
- Device flow OAuth (mobile-friendly)
- Token caching to avoid repeated auth
- Automatic browser opening
- Token expiration handling

**Methods**:
- `authenticate()`: Main auth flow
- `getCachedToken()`: Load saved token
- `deviceFlowAuth()`: Initiate device flow
- `pollForToken()`: Wait for user authorization

### `src/copilot/copilot-client.ts`
**Purpose**: GitHub Copilot API integration
**Key Features**:
- Connects to GitHub Copilot API
- Manages conversation history
- Supports function/tool calling
- Model selection (GPT-4o)

**Methods**:
- `initialize()`: Set up connection
- `chat()`: Send message, get response
- `chatWithTools()`: Enable tool calling
- `addToolResult()`: Feed tool results back
- `clearHistory()`: Reset conversation

### `src/mcp/mcp-server-manager.ts`
**Purpose**: MCP server lifecycle management
**Key Features**:
- Spawns Playwright MCP server
- Connects via stdio transport
- Lists available tools
- Executes tool calls
- Converts MCP tools to OpenAI format

**Methods**:
- `start()`: Launch MCP server
- `launchBrowser()`: Open Chromium
- `callTool()`: Execute an MCP tool
- `getTools()`: List available tools
- `getToolsForLLM()`: Tool format conversion
- `close()`: Cleanup

### `src/agent/browser-agent.ts`
**Purpose**: Agent execution loop
**Key Features**:
- Connects LLM to tools
- Manages agent loop
- Handles tool execution
- Error recovery
- Safety limits (max iterations)

**Methods**:
- `initialize()`: Setup agent
- `executeCommand()`: Main loop
  1. Send user request to LLM
  2. LLM decides which tools to use
  3. Execute tools via MCP
  4. Feed results back to LLM
  5. Repeat until task complete

### `src/cli/cli-interface.ts`
**Purpose**: Command-line user interface
**Key Features**:
- Interactive prompt (inquirer)
- Colored output (chalk)
- Command parsing
- Help system
- Special commands (exit, clear, help)

**Methods**:
- `start()`: Begin CLI loop
- `showHelp()`: Display help
- `stop()`: Cleanup

## Data Flow

```
User Input (CLI)
    ↓
CLI Interface
    ↓
Browser Agent
    ↓
Copilot Client (LLM)
    ↓
[LLM decides which tools to use]
    ↓
MCP Server Manager
    ↓
Playwright MCP Server
    ↓
Chromium Browser
    ↓
[Results flow back up]
    ↓
User sees feedback
```

## Key Technologies

### Runtime
- **Node.js 18+**: JavaScript runtime
- **TypeScript**: Type-safe development
- **ES Modules**: Modern module system

### Core Dependencies
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `axios`: HTTP client for API calls
- `inquirer`: Interactive CLI prompts
- `chalk`: Terminal colors
- `playwright`: Browser automation
- `open`: Open URLs in browser

### APIs and Protocols
- **GitHub OAuth Device Flow**: Authentication
- **GitHub Copilot API**: LLM access  
- **MCP (Model Context Protocol)**: Tool communication
- **OpenAI Function Calling**: Tool format

## Configuration Points

### 1. Model Selection
File: `src/copilot/copilot-client.ts`
```typescript
private model: string = 'gpt-4o';  // Change model here
```

### 2. MCP Server
File: `src/mcp/mcp-server-manager.ts`
```typescript
const serverArgs = ['-y', '@executeautomation/playwright-mcp-server'];
// Change to different MCP server
```

### 3. OAuth Client
File: `src/auth/github-auth.ts`
```typescript
private clientId = 'Iv1.b507a08c87ecfe98';  // GitHub CLI client
```

### 4. Safety Limits
File: `src/agent/browser-agent.ts`
```typescript
let maxIterations = 10;  // Max tool call iterations
```

### 5. System Prompt
File: `src/agent/browser-agent.ts`
```typescript
private systemPrompt = `You are a helpful AI assistant...`;
```

## Build Process

1. **Source**: Write TypeScript in `src/`
2. **Compile**: `npm run build` → TypeScript → JavaScript
3. **Output**: Compiled code in `dist/`
4. **Execute**: `npm start` runs `dist/index.js`

## Environment

### Required
- Node.js 18+
- npm or yarn
- Internet connection

### Optional
- GitHub account with Copilot
- Modern terminal for colors

## Security Notes

- GitHub token stored in `.auth-cache.json` (add to .gitignore)
- Token has limited scope (read:user)
- Device flow is more secure than password auth
- No credentials hard-coded
- MCP runs locally (no remote access)

## Extension Points

Want to customize? Here's where to start:

### Add New Tools
Modify `src/mcp/mcp-server-manager.ts` to use different MCP servers

### Change LLM Provider
Replace `src/copilot/copilot-client.ts` with different API (OpenAI, Anthropic, etc.)

### Different Browser
Modify MCP server to use Firefox or WebKit instead of Chromium

### Add Commands
Extend `src/cli/cli-interface.ts` to handle new special commands

### Enhance Agent
Modify `src/agent/browser-agent.ts` to add memory, context, or planning

## Development Workflow

1. **Edit** TypeScript in `src/`
2. **Build** with `npm run build`
3. **Test** with `npm start`
4. **Debug** with console.log or debugger
5. **Repeat**

### Quick Development
```bash
npm run dev  # Builds and runs in one command
```

### Watch Mode (manual)
```bash
# Terminal 1: Watch for changes
tsc --watch

# Terminal 2: Run (restart manually after changes)
npm start
```

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed solutions.

## License

MIT - See package.json

## Memory Components

The codebase now includes `src/memory/memory-store.ts`, which provides the SQLite-backed long-term memory service and the `save_memory` / `query_memory` tools.
Runtime memory data is stored in `data/agent-memory.sqlite`, and the full design is documented in [MEMORY.md](MEMORY.md).
