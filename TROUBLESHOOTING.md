# Troubleshooting Guide

## Common Issues and Solutions

### Installation Issues

#### "Cannot find module" errors

**Problem**: TypeScript shows errors about missing modules like 'chalk', 'axios', etc.

**Solution**: 
```bash
npm install
```
These errors will disappear after installing dependencies.

#### Playwright installation fails

**Problem**: `npx playwright install chromium` fails or times out

**Solution**:
1. Try with full Playwright install: `npm install -D @playwright/test`
2. Then: `npx playwright install chromium`
3. Check your internet connection
4. Try with a VPN if you're in a restricted region

---

### Authentication Issues

#### Device code flow doesn't open browser

**Problem**: Browser doesn't open automatically for GitHub authentication

**Solution**:
1. Copy the URL shown in the terminal
2. Open it manually in your browser
3. Enter the code shown
4. Complete authorization

#### "Authentication failed" error

**Problem**: Cannot authenticate with GitHub

**Solution**:
1. Check you have a GitHub account
2. Verify you have GitHub Copilot access
3. Delete `.auth-cache.json` and try again
4. Try device flow manually at https://github.com/login/device

#### Token expired

**Problem**: "Token invalid" or similar errors

**Solution**:
```bash
# Delete the cached token
rm .auth-cache.json   # macOS/Linux
del .auth-cache.json  # Windows

# Run again
npm start
```

---

### GitHub Copilot Issues

#### "Copilot API error"

**Problem**: Cannot connect to GitHub Copilot API

**Solutions**:
1. Verify you have an active Copilot subscription
2. Check GitHub Copilot status: https://www.githubstatus.com/
3. Your GitHub token might not have Copilot access
4. Try re-authenticating (delete `.auth-cache.json`)

#### Model not available

**Problem**: GPT-4o model not available

**Solution**:
Edit `src/copilot/copilot-client.ts` and try a different model:
```typescript
private model: string = 'gpt-4';  // or 'gpt-3.5-turbo'
```

---

### MCP Server Issues

#### "MCP client not initialized"

**Problem**: MCP server fails to start

**Solutions**:
1. Check if the MCP server package is available:
   ```bash
   npx @executeautomation/playwright-mcp-server --version
   ```
2. Install it explicitly if needed
3. Check for port conflicts (MCP uses stdio, but child process might have issues)

#### "Cannot find playwright_navigate tool"

**Problem**: MCP tools not available

**Solutions**:
1. Restart the application
2. Check MCP server logs
3. Try a different Playwright MCP server package
4. Ensure Playwright is properly installed: `npx playwright install`

---

### Browser Issues

#### Browser doesn't launch

**Problem**: Chromium browser doesn't open

**Solutions**:
1. Install Playwright browsers:
   ```bash
   npx playwright install chromium
   ```
2. Check if Chromium is blocked by antivirus/firewall
3. Try running as administrator (Windows) or with sudo (Linux)
4. Check available disk space

#### Browser crashes or hangs

**Problem**: Browser becomes unresponsive

**Solutions**:
1. Restart the application
2. Check system resources (RAM, CPU)
3. Close other browser instances
4. Update Playwright: `npm update playwright`

---

### Runtime Issues

#### "Maximum actions reached"

**Problem**: Agent stops with "reached maximum number of actions"

**Solution**:
1. This is a safety limit to prevent infinite loops
2. Try breaking down your request into smaller steps
3. Increase the limit in `src/agent/browser-agent.ts`:
   ```typescript
   let maxIterations = 20;  // Increase from 10
   ```

#### Commands not executing

**Problem**: Agent doesn't perform browser actions

**Solutions**:
1. Be more specific in your commands
2. Check if the page has loaded: "what page am I on?"
3. Wait for page load: "wait 3 seconds then click the button"
4. Check console output for error messages

#### Slow responses

**Problem**: Agent takes a long time to respond

**Solutions**:
1. This is normal for complex tasks
2. The AI needs to think and plan actions
3. For simple navigation, be very direct: "go to google.com"
4. Check your internet connection

---

### CLI Issues

#### Terminal rendering issues

**Problem**: CLI looks broken or doesn't display properly

**Solutions**:
1. Use a modern terminal (Windows Terminal, iTerm2, etc.)
2. Enable UTF-8 encoding
3. Try a different terminal emulator

#### Cannot type commands

**Problem**: Input prompt doesn't appear

**Solutions**:
1. Press Ctrl+C to force restart
2. Check if another process is using stdin
3. Run in a different terminal

#### Colors not showing

**Problem**: Chalk colors don't display

**Solution**:
1. Your terminal might not support colors
2. Enable ANSI colors in your terminal settings
3. Try Windows Terminal on Windows

---

### Performance Issues

#### High CPU usage

**Problem**: Application uses a lot of CPU

**Solutions**:
1. This is normal during browser automation
2. Close the browser when not needed
3. Limit the complexity of tasks
4. Check for runaway processes

#### High memory usage

**Problem**: Application uses excessive RAM

**Solutions**:
1. Restart the application periodically
2. Close the browser between sessions
3. Limit the number of open tabs/pages
4. Update to the latest Playwright version

---

### Development Issues

#### TypeScript compilation errors

**Problem**: `npm run build` fails

**Solutions**:
1. Check Node.js version: `node --version` (need 18+)
2. Clean build: `rm -rf dist && npm run build`
3. Reinstall dependencies: `rm -rf node_modules && npm install`
4. Check for syntax errors in TypeScript files

#### Module import errors

**Problem**: "Cannot find module" at runtime

**Solutions**:
1. Rebuild the project: `npm run build`
2. Check file extensions in imports (should be `.js` in compiled code)
3. Verify `package.json` has `"type": "module"`

---

## Getting Help

If none of these solutions work:

1. **Check the logs**: Look at terminal output for specific error messages
2. **Check GitHub Issues**: See if others have the same problem
3. **Update dependencies**: `npm update`
4. **Fresh install**: 
   ```bash
   rm -rf node_modules dist .auth-cache.json
   npm install
   npm run build
   npm start
   ```

## Reporting Issues

When reporting a problem, include:
- Your OS and Node.js version
- Complete error message
- Steps to reproduce
- What you were trying to do
- Any unusual environment setup

## Debug Mode

To enable verbose logging, edit the files and add console.log statements, or set environment variables:

```bash
# Windows
set DEBUG=*
npm start

# macOS/Linux  
DEBUG=* npm start
```
