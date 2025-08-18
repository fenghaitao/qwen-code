/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Part,
  Content,
  FinishReason,
} from '@google/genai';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator.js';
import { Config } from '../config/config.js';
import { GitHubCopilotOAuth2Client } from './githubCopilotOAuth2.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * GitHub Copilot API response interface
 */
interface GitHubCopilotResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * GitHub Copilot streaming response interface
 */
interface GitHubCopilotStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

/**
 * Content generator implementation for GitHub Copilot
 */
export class GitHubCopilotContentGenerator extends OpenAIContentGenerator {
  private static readonly COPILOT_API_BASE = 'https://api.githubcopilot.com';
  private static readonly DEFAULT_MODEL = 'gpt-4';
  private copilotClient: GitHubCopilotOAuth2Client;

  constructor(
    client: GitHubCopilotOAuth2Client,
    model: string,
    config: Config,
  ) {
    // Create a dummy API key since we'll override the HTTP calls
    super('dummy-key', model, config);
    this.copilotClient = client;
  }

  /**
   * Override to suppress error logging for authentication failures
   */
  protected shouldSuppressErrorLogging(
    error: unknown,
    _request: GenerateContentParameters,
  ): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return errorMessage.includes('GitHub Copilot authentication');
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.withValidToken(async (token) => {
      const messages = this.convertToOpenAIFormat(request);
      const samplingParams = this.buildSamplingParameters(request);
      
      const requestBody: any = {
        model: this.model || GitHubCopilotContentGenerator.DEFAULT_MODEL,
        messages,
        ...samplingParams,
        stream: false,
      };

      // Add tools if present
      if (request.config?.tools) {
        requestBody.tools = await this.convertGeminiToolsToOpenAI(request.config.tools);
      }

      const response = await fetch(`${GitHubCopilotContentGenerator.COPILOT_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'Editor-Version': 'vscode/1.99.3',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // If we get a 401, it means the token is invalid, so we should clear credentials
        if (response.status === 401) {
          await this.copilotClient.clearCredentials();
          throw new Error('GitHub Copilot authentication has expired. Please authenticate with GitHub Copilot again.');
        }
        throw new Error(`GitHub Copilot API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const copilotResponse = await response.json() as GitHubCopilotResponse;
      // Convert GitHub Copilot response to OpenAI format for parent class method
      const openaiResponse = this.convertCopilotToOpenAIResponse(copilotResponse);
      return this.convertToGeminiFormat(openaiResponse);
    });
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.withValidTokenForStream(async (token) => {
      const messages = this.convertToOpenAIFormat(request);
      const samplingParams = this.buildSamplingParameters(request);
      
      const requestBody: any = {
        model: this.model || GitHubCopilotContentGenerator.DEFAULT_MODEL,
        messages,
        ...samplingParams,
        stream: true,
        stream_options: { include_usage: true },
      };

      // Add tools if present
      if (request.config?.tools) {
        requestBody.tools = await this.convertGeminiToolsToOpenAI(request.config.tools);
      }

      const response = await fetch(`${GitHubCopilotContentGenerator.COPILOT_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'Editor-Version': 'vscode/1.99.3',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // If we get a 401, it means the token is invalid, so we should clear credentials
        if (response.status === 401) {
          await this.copilotClient.clearCredentials();
          throw new Error('GitHub Copilot authentication has expired. Please authenticate with GitHub Copilot again.');
        }
        throw new Error(`GitHub Copilot API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body received from GitHub Copilot API');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Create and return an async generator function
      const self = this;
      async function* streamGenerator() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim() === '') continue;
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  return;
                }

                try {
                  const parsed = JSON.parse(data) as GitHubCopilotStreamResponse;
                  // Convert GitHub Copilot stream response to OpenAI format for parent class method
                  const openaiChunk = self.convertCopilotToOpenAIStreamChunk(parsed);
                  const geminiResponse = self.convertStreamChunkToGeminiFormat(openaiChunk);
                  if (geminiResponse) {
                    yield geminiResponse;
                  }
                } catch (error) {
                  console.warn('Failed to parse streaming response:', error);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      // Return the async generator
      return streamGenerator();
    });
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    throw new Error('GitHub Copilot does not support embedding content');
  }

  /**
   * Execute operation with a valid token, with retry on auth failure
   */
  private async withValidToken<T>(
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.getTokenWithRetry();
    return await operation(token);
  }

  /**
   * Execute operation with a valid token for streaming, with retry on auth failure
   */
  private async withValidTokenForStream<T>(
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.getTokenWithRetry();
    return await operation(token);
  }

  /**
   * Get token with retry logic
   */
  private async getTokenWithRetry(): Promise<string> {
    try {
      return await this.getValidToken();
    } catch (error) {
      console.error('Failed to get valid GitHub Copilot token:', error);
      throw new Error(
        'Failed to obtain valid GitHub Copilot access token. Please re-authenticate.',
      );
    }
  }

  /**
   * Get a valid access token, attempting to trigger OAuth flow if needed
   */
  private async getValidToken(): Promise<string> {
    // Try to get a valid token first
    let token = await this.copilotClient.getValidAccessToken();
    if (token) {
      return token;
    }

    // If we don't have a valid token, try to trigger the OAuth flow
    console.log('No valid GitHub Copilot token found, attempting to trigger OAuth flow...');
    const success = await this.copilotClient.triggerOAuthFlow();
    if (success) {
      // Try to get the token again after OAuth flow
      token = await this.copilotClient.getValidAccessToken();
      if (token) {
        return token;
      }
    }

    // If we still don't have a valid token, throw an error
    throw new Error('GitHub Copilot authentication required. Please authenticate with GitHub Copilot first.');
  }

  /**
   * Convert GitHub Copilot response to OpenAI format
   */
  private convertCopilotToOpenAIResponse(copilotResponse: GitHubCopilotResponse): any {
    return {
      id: copilotResponse.id,
      object: copilotResponse.object,
      created: copilotResponse.created,
      model: copilotResponse.model,
      choices: copilotResponse.choices.map(choice => ({
        index: choice.index,
        message: {
          role: choice.message.role as 'assistant',
          content: choice.message.content,
          ...(choice.message.tool_calls && { tool_calls: choice.message.tool_calls }),
        },
        finish_reason: choice.finish_reason,
        logprobs: null, // GitHub Copilot doesn't provide logprobs
      })),
      usage: copilotResponse.usage,
    };
  }

  /**
   * Convert GitHub Copilot stream chunk to OpenAI format
   */
  private convertCopilotToOpenAIStreamChunk(copilotChunk: GitHubCopilotStreamResponse): any {
    return {
      id: copilotChunk.id,
      object: copilotChunk.object,
      created: copilotChunk.created,
      model: copilotChunk.model,
      choices: copilotChunk.choices.map(choice => ({
        index: choice.index,
        delta: {
          role: choice.delta.role as 'assistant' | undefined,
          content: choice.delta.content,
          ...(choice.delta.tool_calls && { tool_calls: choice.delta.tool_calls }),
        },
        finish_reason: choice.finish_reason,
        logprobs: null,
      })),
    };
  }

}