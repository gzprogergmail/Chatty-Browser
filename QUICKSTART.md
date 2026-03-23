# Quick Start Guide

## Setup (One-time)

1. Install dependencies:
```bash
npm install
```

2. Install Playwright browsers:
```bash
npx playwright install chromium
```

3. Build the project:
```bash
npm run build
```

## Run

```bash
npm start
```

## First Time?

When you first run the app:

1. A browser window will open to GitHub
2. Authorize the device with the code shown
3. Close the browser when done
4. The CLI will start automatically

## Example Session

```
You: go to news.ycombinator.com
🤖 Agent: Navigating to Hacker News...

You: click on the first article
🤖 Agent: Clicking on the top story...

You: take a screenshot
🤖 Agent: Screenshot saved!

You: exit
👋 Goodbye!
```

## Tips

- Be specific with your commands
- Use natural language - the AI understands context
- If something fails, try rephrasing
- Use `help` to see examples
- Use `clear` to clean up the terminal

## Need Help?

See the full [README.md](README.md) for detailed documentation.

## Memory Notes

The agent now keeps long-term reusable memory in `data/agent-memory.sqlite` and exposes `save_memory` plus `query_memory` to the LLM.
That memory is intended for reusable site knowledge, workflows, and preferences rather than raw conversation dumps.
See [MEMORY.md](MEMORY.md) for the full mechanism.
