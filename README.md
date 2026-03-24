# Self-Contained Browser Agent

A command-line application that allows you to control a web browser using natural language commands powered by GitHub Copilot and Playwright via MCP (Model Context Protocol).

## Features

- 🔐 **GitHub OAuth Authentication** - Secure device flow authentication
- 🤖 **Copilot Integration** - Uses GitHub Copilot with `gpt-5-mini`
- 💭 **Live Thinking Stream** - Shows Copilot reasoning summaries when the selected model/session emits them
- 🌐 **Browser Automation** - Controls Chromium browser via Playwright MCP server
- 💬 **Interactive CLI** - Natural language command interface
- 🔧 **MCP Tools** - Full access to Playwright automation capabilities

## Prerequisites

- Node.js 18 or higher
- npm or yarn
- GitHub account with Copilot access

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

## Usage

### Quick Test (No Authentication Required)

Try the demo mode first to see how the CLI works:
```bash
npm run demo
```

This runs a mock agent that simulates the interface without requiring GitHub authentication.

### Full Application

Start the application:
```bash
npm start
```

Or in development mode:
```bash
npm run dev
```

### First Run

On first run, you'll be guided through:

1. **GitHub Authentication** - A browser will open for you to authorize the application
2. **Copilot Connection** - Automatically connects to `gpt-5-mini` with `medium` reasoning
3. **MCP Server Start** - Launches the Playwright MCP server
4. **Browser Launch** - Opens Chromium browser
5. **CLI Ready** - Start typing commands!

### Example Commands

Once the CLI is ready, you can type natural language commands:

```
You: Go to google.com
You: Search for "artificial intelligence news"
You: Click on the first result
You: Take a screenshot
You: Scroll down the page
You: Find the email signup form and enter test@example.com
You: Click the submit button
```

### Special Commands

- `help` - Show available commands
- `clear` - Clear the terminal screen
- `exit` or `quit` - Exit the application

## How It Works

1. **Authentication**: Uses GitHub's device flow OAuth to authenticate
2. **Copilot API**: Connects to GitHub Copilot's API with `gpt-5-mini` and `medium` reasoning
3. **MCP Server**: Spawns Playwright MCP server as a subprocess
4. **Agent Loop**: 
   - Receives your natural language command
   - Copilot decides which Playwright tools to use
   - Executes tools via MCP protocol
   - Returns results and feedback
5. **CLI Interface**: Provides an interactive command-line experience

## Architecture

```
src/
├── index.ts                 # Main entry point
├── auth/
│   └── github-auth.ts      # GitHub OAuth device flow
├── copilot/
│   └── copilot-client.ts   # GitHub Copilot API client
├── mcp/
│   └── mcp-server-manager.ts # MCP server management
├── agent/
│   └── browser-agent.ts    # Agent orchestration
└── cli/
    └── cli-interface.ts    # CLI interface
```

## Configuration

### Using a Different Model

Edit `src/copilot/copilot-client.ts` to change the default model:
```typescript
private model: string = 'gpt-4o'; // Change to your preferred model
```

### Custom MCP Server

Edit `src/mcp/mcp-server-manager.ts` to use a different MCP server:
```typescript
const serverArgs = ['-y', '@your-mcp-server-package'];
```

## Troubleshooting

### Authentication Issues

- Ensure you have a GitHub account with Copilot access
- Check that you completed the device authorization
- Delete `.auth-cache.json` and try again

### MCP Server Issues

- Ensure Playwright is installed: `npx playwright install chromium`
- Check that the MCP server package is available
- Look for error messages in the console

### Browser Not Launching

- Install Playwright browsers: `npx playwright install`
- Check firewall settings
- Ensure no other process is using the browser

## Testing

Run the automated tests:
```bash
npm test                # Component tests
node integration-test.js # Integration tests
npm run demo            # Interactive demo mode
```

See [TESTING.md](TESTING.md) for detailed testing information and results.

## License

MIT

## Credits

- GitHub Copilot for AI capabilities
- Playwright for browser automation
- Model Context Protocol for tool integration

## Memory System

The agent now includes a SQLite-backed long-term memory layer with `save_memory` and `query_memory` tools.
The database lives at `data/agent-memory.sqlite`, uses FTS for retrieval, and is meant for distilled reusable knowledge rather than raw transcripts.
See [MEMORY.md](MEMORY.md) for the full design and retrieval rules.
