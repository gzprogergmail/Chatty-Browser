import axios, { AxiosInstance } from 'axios';

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

    const payload: any = {
      messages: this.conversationHistory,
      model: this.model,
      temperature: 0.7,
      max_tokens: 2000,
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
    // Add tool response in OpenAI format
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    });
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getHistory(): Message[] {
    return [...this.conversationHistory];
  }
}
