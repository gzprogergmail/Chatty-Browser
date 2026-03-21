import axios, { AxiosInstance } from 'axios';
import chalk from 'chalk';

// GPT-4o supports a 128 k-token context window.
// We reserve a portion for the completion so the model has room to respond.
const MAX_CONTEXT_TOKENS = 128_000;
const MAX_RESPONSE_TOKENS = 4_096;
const MAX_INPUT_TOKENS = MAX_CONTEXT_TOKENS - MAX_RESPONSE_TOKENS; // ~123 904

// Rough heuristic: 1 token ≈ 4 characters (works well for English + JSON).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Replace base64-encoded image payloads in a tool-result string with a
 * compact placeholder.  This keeps screenshots from consuming thousands of
 * tokens in the conversation history while still preserving every other part
 * of the tool result (status, metadata, etc.).
 *
 * Why this is safe: the LLM already used the image to decide on follow-up
 * actions in the same iteration.  Subsequent turns only need the fact that a
 * screenshot was taken, not the pixel data.
 */
function stripImageData(content: string): string {
  // Match data-URL style base64 blobs longer than ~100 chars
  const stripped = content.replace(
    /data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
    '[image-data-omitted]',
  );
  if (stripped !== content) {
    // The whole value was effectively a screenshot payload – summarise it.
    return '[Screenshot captured. Pixel data omitted from context to preserve token budget.]';
  }

  // Also catch raw base64 strings that appear as JSON field values and are
  // suspiciously long (>= 500 chars with no whitespace → likely binary data).
  return stripped.replace(
    /"([A-Za-z0-9+/=]{500,})"/g,
    '"[binary-data-omitted]"',
  );
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

interface CopilotResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
}

export class CopilotClient {
  private client: AxiosInstance;
  private model: string = 'gpt-4o';
  private conversationHistory: Message[] = [];
  private copilotToken: string = '';

  constructor(private token: string) {
    this.client = axios.create({
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/json',
        'Editor-Version': 'vscode/1.85.0',
        'Editor-Plugin-Version': 'copilot-chat/0.12.0',
        'User-Agent': 'GitHubCopilot/1.0',
      },
    });
  }

  async initialize(model: string = 'gpt-4o') {
    this.model = model;
    
    // Get Copilot token from GitHub token
    try {
      const response = await this.client.get('https://api.github.com/copilot_internal/v2/token');
      this.copilotToken = response.data.token;
      
      // Update client with Copilot token
      this.client = axios.create({
        baseURL: 'https://api.githubcopilot.com',
        headers: {
          'Authorization': `Bearer ${this.copilotToken}`,
          'Content-Type': 'application/json',
          'Editor-Version': 'vscode/1.85.0',
          'Editor-Plugin-Version': 'copilot-chat/0.12.0',
          'Openai-Organization': 'github-copilot',
          'Openai-Intent': 'conversation-panel',
          'User-Agent': 'GitHubCopilot/1.0',
        },
      });
      
      console.log('   Copilot token obtained successfully');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new Error('GitHub Copilot is not available for this account. Please ensure you have an active Copilot subscription.');
        }
        throw new Error(`Failed to get Copilot token: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  async chat(userMessage: string, tools?: any[]): Promise<{ content: string; toolCalls?: any[] }> {
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    });

    // Drop the oldest messages if we are about to overflow the context window.
    const dropped = this.pruneHistoryForContext();
    if (dropped > 0) {
      console.log(chalk.yellow(`\n⚠️  Context window near full – dropped ${dropped} oldest message(s) to make room.\n`));
    }

    const payload: any = {
      messages: this.conversationHistory,
      model: this.model,
      temperature: 0.7,
      max_tokens: MAX_RESPONSE_TOKENS,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    try {
      const response = await this.client.post<CopilotResponse>(
        '/chat/completions',
        payload
      );

      const choice = response.data.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to history (with tool calls if present)
      const historyMessage: Message = {
        role: 'assistant',
        content: assistantMessage.content || '',
      };
      
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        historyMessage.tool_calls = assistantMessage.tool_calls;
      }
      
      this.conversationHistory.push(historyMessage);

      return {
        content: assistantMessage.content || '',
        toolCalls: assistantMessage.tool_calls,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Copilot API error: ${error.response?.data?.error?.message || error.message}`);
      }
      throw error;
    }
  }

  async chatWithTools(userMessage: string, tools: any[]): Promise<{ content: string; toolCalls?: any[] }> {
    return this.chat(userMessage, tools);
  }

  addToolResult(toolCallId: string, toolName: string, result: any) {
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    const content = stripImageData(raw);

    // Add tool response in OpenAI format
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content,
    });
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  // ── Token accounting ──────────────────────────────────────────────────────

  private estimateHistoryTokens(): number {
    return this.conversationHistory.reduce(
      (sum, msg) => sum + estimateTokens(JSON.stringify(msg)),
      0,
    );
  }

  /** Approximate token usage for the current conversation history. */
  getTokenUsage(): { used: number; max: number } {
    return { used: this.estimateHistoryTokens(), max: MAX_CONTEXT_TOKENS };
  }

  /**
   * Drop the oldest messages from history until the estimated token count
   * fits within MAX_INPUT_TOKENS.  Tool messages that would be left dangling
   * at the front (without their matching assistant turn) are also removed.
   * Returns the number of messages dropped.
   */
  private pruneHistoryForContext(): number {
    let dropped = 0;
    while (
      this.estimateHistoryTokens() > MAX_INPUT_TOKENS &&
      this.conversationHistory.length > 1
    ) {
      this.conversationHistory.shift();
      dropped++;
    }
    // Remove any orphaned tool messages now at the front.
    while (
      this.conversationHistory.length > 0 &&
      this.conversationHistory[0].role === 'tool'
    ) {
      this.conversationHistory.shift();
      dropped++;
    }
    return dropped;
  }
}
