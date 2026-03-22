import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface Tool {
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPServerManager {
  private client: Client | null = null;
  private tools: Tool[] = [];
  private browserLaunched = false;

  async start() {
    // Start the Playwright MCP server via StdioClientTransport
    // The transport will handle spawning the process
    const serverCommand = 'npx';
    const serverArgs = ['-y', '@playwright/mcp', '--browser', 'chrome', '--isolated'];

    // Set environment variables to force headed mode
    const env = {
      ...process.env,
      HEADLESS: 'false',
      PLAYWRIGHT_HEADLESS: '0',
    };

    // Create MCP client with stdio transport
    const transport = new StdioClientTransport({
      command: serverCommand,
      args: serverArgs,
      env,
    });

    this.client = new Client(
      {
        name: 'browser-agent-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    try {
      await this.client.connect(transport);

      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools as Tool[];

      console.log('   Playwright MCP configured for isolated Chrome sessions');
      console.log(`   Available MCP tools: ${this.tools.map(t => t.name).join(', ')}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start MCP server: ${errorMsg}. Make sure @playwright/mcp is available.`);
    }
  }

  async launchBrowser() {
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    // First, try to install/configure browser in headed mode
    const installTool = this.tools.find(t => t.name.includes('install'));
    if (installTool) {
      try {
        console.log(`   Configuring browser to run in headed mode...`);
        await this.client.callTool({
          name: installTool.name,
          arguments: {
            headless: false,
          },
        });
      } catch (error) {
        // Installation might not be needed if already installed
        console.log(`   Browser configuration: ${error instanceof Error ? error.message : 'using defaults'}`);
      }
    }

    // Find the navigate tool - different servers might name it differently
    const navigateTool = this.tools.find(t => 
      t.name.includes('navigate') && !t.name.includes('back')
    );

    if (!navigateTool) {
      console.log('   No navigate tool found, browser will launch on first action');
      this.browserLaunched = true;
      return;
    }

    try {
      console.log(`   Calling ${navigateTool.name} to launch browser with visible window...`);
      const result = await this.client.callTool({
        name: navigateTool.name,
        arguments: {
          url: 'about:blank',
        },
      });
      console.log(`   Browser window opened successfully`);
      this.browserLaunched = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to launch browser: ${errorMsg}`);
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    return result;
  }

  getTools(): Tool[] {
    return this.tools;
  }

  getToolsForLLM(): any[] {
    // Convert MCP tools to OpenAI function calling format
    return this.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error('Error closing MCP client:', error);
      }
    }
  }
}
