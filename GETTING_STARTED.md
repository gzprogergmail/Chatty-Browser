# Getting Started - First Run

This guide walks you through your first time using the Self-Contained Browser Agent.

## Prerequisites Check

Before starting, verify you have:

- [ ] Node.js 18 or later installed
  ```bash
  node --version
  ```
  
- [ ] npm installed (comes with Node.js)
  ```bash
  npm --version
  ```
  
- [ ] A GitHub account
  
- [ ] GitHub Copilot subscription (required for GPT-4o access)

## Step 1: Installation

### Quick Setup (Recommended)

**Windows:**
```bash
setup.bat
```

**macOS/Linux:**
```bash
chmod +x setup.sh
./setup.sh
```

### Manual Setup

If you prefer to run commands manually:

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Build the project
npm run build
```

## Step 2: First Run

Start the application:

```bash
npm start
```

You'll see output like this:

```
🤖 Self-Contained Browser Agent

Step 1: Authenticating with GitHub...
```

## Step 3: GitHub Authentication

### What happens:

1. Your default browser will open automatically
2. You'll see a GitHub device authorization page
3. A code will be displayed in both your terminal and browser

### What to do:

1. Check that the code in your browser matches the terminal
2. Click "Authorize" on the GitHub page
3. You may be asked to sign in to GitHub first
4. After authorization, close the browser tab

### Terminal shows:

```
📱 Please authorize this device:
   Go to: https://github.com/login/device
   Enter code: XXXX-XXXX

.........
✓ GitHub authentication successful
```

The dots (`.`) represent polling while waiting for you to authorize.

### Troubleshooting:

- **Browser doesn't open?** Copy the URL and open it manually
- **Code doesn't work?** Make sure you entered it exactly as shown
- **Authorization fails?** Check you're signed into the correct GitHub account

## Step 4: Copilot Connection

Next, the app connects to GitHub Copilot:

```
Step 2: Connecting to GitHub Copilot (GPT-4o)...
✓ Copilot connected with GPT-4o
```

### Requirements:

- Active GitHub Copilot subscription
- Token from Step 3 must have Copilot access

### Troubleshooting:

- **"Copilot API error"?** Verify you have an active Copilot subscription
- Check https://github.com/settings/copilot to confirm

## Step 5: MCP Server Start

The Playwright MCP server launches:

```
Step 3: Starting Playwright MCP Server...
   Available MCP tools: playwright_navigate, playwright_click, ...
✓ MCP Server started
```

### What's happening:

- Downloads MCP server if needed (first time only)
- Starts the server as a background process
- Lists available browser automation tools

### Troubleshooting:

- **Slow download?** Be patient on first run
- **Install fails?** Check your internet connection
- **Permission error?** Run as administrator (Windows) or with sudo (Linux)

## Step 6: Browser Launch

Chromium browser opens:

```
Step 4: Launching Chromium browser...
✓ Browser launched
```

### What you'll see:

- A Chromium browser window opens
- Shows "about:blank" initially
- This is the browser the agent will control

### Troubleshooting:

- **Browser doesn't open?** Check if antivirus is blocking it
- **Crashes immediately?** Update Playwright: `npx playwright install chromium`

## Step 7: Ready to Use!

You're now at the interactive CLI:

```
🚀 Ready! You can now give commands to control the browser.

Type your commands below. Type "exit" or "quit" to stop.

You: _
```

## Your First Commands

Try these simple commands to get started:

### 1. Navigate to a website

```
You: go to google.com
```

The agent will:
- Understand your intent
- Use the `playwright_navigate` tool
- Navigate the browser to Google

### 2. Perform a search

```
You: search for "github copilot"
```

The agent will:
- Find the search box
- Type your query
- Submit the search

### 3. Take a screenshot

```
You: take a screenshot
```

The agent will:
- Capture the current page
- Save it to a file
- Tell you where it's saved

### 4. Get help

```
You: help
```

Shows available commands and examples.

## Understanding the Agent's Responses

### When executing actions:

```
🤖 Agent: Processing...

🔧 Executing actions...
   → playwright_navigate({"url":"https://google.com"})
   ✓ playwright_navigate completed

🤖 Agent: I've navigated to Google's homepage.
```

### Action indicators:

- `🔧 Executing actions...` - Agent is working
- `→ tool_name(args)` - Calling a specific tool
- `✓ tool_name completed` - Tool succeeded
- `✗ tool_name failed` - Tool encountered an error
- `🤖 Agent: ...` - Agent's response to you

## What to Try Next

See [EXAMPLES.md](EXAMPLES.md) for more command ideas:

- Navigate to different sites
- Fill out forms
- Click elements
- Extract information
- Multi-step tasks

## Tips for Success

### 1. Be Specific
❌ "click the button"
✅ "click the login button"

### 2. One Task at a Time (or describe the full flow)
❌ "Do everything needed to buy a laptop"
✅ "Go to Amazon and search for laptops"

Or:
✅ "Go to Amazon, search for laptops, and click on the first result"

### 3. Check State When Confused
```
You: what page am I on?
```

### 4. Wait for Slow Pages
```
You: go to bigwebsite.com and wait 3 seconds
```

### 5. Use Help When Stuck
```
You: help
```

## Exiting the Application

To quit:

```
You: exit
```

Or:

```
You: quit
```

Or press `Ctrl+C` twice.

The browser will close automatically.

## Next Run

On subsequent runs:

1. Authentication is cached (no need to re-authorize)
2. Setup is faster (dependencies already installed)
3. You'll go straight to the CLI

Just run:
```bash
npm start
```

## Token Expiration

Your GitHub token is cached in `.auth-cache.json` and lasts 1 year.

If it expires, delete the file and run again:

```bash
# Windows
del .auth-cache.json

# macOS/Linux
rm .auth-cache.json

# Then
npm start
```

## Getting Help

- **Examples**: See [EXAMPLES.md](EXAMPLES.md)
- **Problems**: See [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Architecture**: See [STRUCTURE.md](STRUCTURE.md)
- **Main docs**: See [README.md](README.md)

## Common First-Run Issues

### "Cannot find module"
- **Cause**: Dependencies not installed
- **Fix**: Run `npm install`

### "Authentication failed"
- **Cause**: Incorrect code or expired session
- **Fix**: Delete `.auth-cache.json` and try again

### "Copilot API error"
- **Cause**: No Copilot subscription
- **Fix**: Subscribe at https://github.com/copilot

### Browser won't launch
- **Cause**: Playwright browsers not installed
- **Fix**: Run `npx playwright install chromium`

## Success Checklist

You know it's working when:

- [x] GitHub authentication completes without errors
- [x] Copilot connection succeeds
- [x] MCP server starts and lists tools
- [x] Chromium browser opens
- [x] CLI prompt appears: `You: _`
- [x] Test command works (e.g., "go to google.com")

## Ready to Build!

You now have a working AI agent that can:
- Understand natural language
- Control a web browser
- Execute complex multi-step tasks
- Provide feedback in real-time

Explore, experiment, and enjoy! 🚀
