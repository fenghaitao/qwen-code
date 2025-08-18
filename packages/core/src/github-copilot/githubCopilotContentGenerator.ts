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
import { ContentGenerator } from '../core/contentGenerator.js';
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
      content: string;
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
    };
    finish_reason?: string;
  }>;
}

/**
 * Content generator implementation for GitHub Copilot
 */
export class GitHubCopilotContentGenerator implements ContentGenerator {
  private static readonly COPILOT_API_BASE = 'https://api.githubcopilot.com';
  private static readonly DEFAULT_MODEL = 'gpt-4';

  constructor(
    private client: GitHubCopilotOAuth2Client,
    private model: string,
    private config: Config,
  ) {}

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const token = await this.client.getValidAccessToken();
    if (!token) {
      throw new Error('GitHub Copilot authentication required. Please authenticate with GitHub Copilot first.');
    }

    const messages = this.convertToOpenAIMessages(request.contents as Content[]);
    const requestBody = {
      model: this.model || GitHubCopilotContentGenerator.DEFAULT_MODEL,
      messages,
      max_tokens: request.config?.maxOutputTokens || 4096,
      temperature: request.config?.temperature || 0.7,
      top_p: request.config?.topP || 1.0,
      stream: false,
    };

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
      throw new Error(`GitHub Copilot API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const copilotResponse = await response.json() as GitHubCopilotResponse;
    return this.convertToGeminiResponse(copilotResponse);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const token = await this.client.getValidAccessToken();
    if (!token) {
      throw new Error('GitHub Copilot authentication required. Please authenticate with GitHub Copilot first.');
    }

    const messages = this.convertToOpenAIMessages(request.contents as Content[]);
    const requestBody = {
      model: this.model || GitHubCopilotContentGenerator.DEFAULT_MODEL,
      messages,
      max_tokens: request.config?.maxOutputTokens || 4096,
      temperature: request.config?.temperature || 0.7,
      top_p: request.config?.topP || 1.0,
      stream: true,
    };

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
                const geminiResponse = self.convertStreamToGeminiResponse(parsed);
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
  }

  async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    // GitHub Copilot doesn't provide a token counting endpoint
    // Provide a rough estimate based on content length
    const content = JSON.stringify(request.contents);
    
    // Rough estimate: ~4 characters per token for English text
    const estimatedTokens = Math.ceil(content.length / 4);
    
    return {
      totalTokens: estimatedTokens,
    };
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    throw new Error('GitHub Copilot does not support embedding content');
  }

  private convertToOpenAIMessages(contents: Content[]): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // Handle different content types based on OpenAIContentGenerator pattern
    if (Array.isArray(contents)) {
      for (const content of contents) {
        if (typeof content === 'string') {
          messages.push({ role: 'user', content });
        } else if ('role' in content && 'parts' in content) {
          const role = content.role === 'user' ? 'user' : 'assistant';
          let text = '';
          
          if (Array.isArray(content.parts)) {
            text = content.parts.map(part => {
              if (typeof part === 'string') {
                return part;
              } else if ('text' in part && part.text) {
                return part.text;
              } else if ('inlineData' in part && part.inlineData) {
                // GitHub Copilot doesn't support inline data, so we'll describe it
                return `[Image data: ${part.inlineData.mimeType}]`;
              }
              return '';
            }).join('') || '';
          }

          if (text.trim()) {
            messages.push({ role, content: text });
          }
        }
      }
    } else if (contents) {
      // Handle single content object
      if (typeof contents === 'string') {
        messages.push({ role: 'user', content: contents });
      } else if ('role' in contents && 'parts' in contents) {
        const content = contents as Content;
        const role = content.role === 'user' ? 'user' : 'assistant';
        let text = '';
        
        if (Array.isArray(content.parts)) {
          text = content.parts.map(part => {
            if (typeof part === 'string') {
              return part;
            } else if ('text' in part && part.text) {
              return part.text;
            } else if ('inlineData' in part && part.inlineData) {
              // GitHub Copilot doesn't support inline data, so we'll describe it
              return `[Image data: ${part.inlineData.mimeType}]`;
            }
            return '';
          }).join('') || '';
        }

        if (text.trim()) {
          messages.push({ role, content: text });
        }
      }
    }

    return messages;
  }

  private convertToGeminiResponse(copilotResponse: GitHubCopilotResponse): GenerateContentResponse {
    const choice = copilotResponse.choices[0];
    if (!choice) {
      throw new Error('No choices in GitHub Copilot response');
    }

    const response = new GenerateContentResponse();
    const parts: Part[] = [];
    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    response.candidates = [
      {
        content: {
          parts,
          role: 'model',
        },
        finishReason: this.mapFinishReason(choice.finish_reason),
        index: choice.index,
        safetyRatings: [],
      },
    ];

    response.usageMetadata = {
      promptTokenCount: copilotResponse.usage.prompt_tokens,
      candidatesTokenCount: copilotResponse.usage.completion_tokens,
      totalTokenCount: copilotResponse.usage.total_tokens,
    };

    response.responseId = copilotResponse.id;
    response.modelVersion = copilotResponse.model;
    response.promptFeedback = { safetyRatings: [] };

    return response;
  }

  private convertStreamToGeminiResponse(copilotResponse: GitHubCopilotStreamResponse): GenerateContentResponse | null {
    const choice = copilotResponse.choices[0];
    if (!choice || !choice.delta.content) {
      return null;
    }

    const response = new GenerateContentResponse();
    const parts: Part[] = [];
    if (choice.delta.content) {
      parts.push({ text: choice.delta.content });
    }

    response.candidates = [
      {
        content: {
          parts,
          role: 'model',
        },
        finishReason: choice.finish_reason ? this.mapFinishReason(choice.finish_reason) : undefined,
        index: choice.index,
        safetyRatings: [],
      },
    ];

    response.responseId = copilotResponse.id;
    response.modelVersion = copilotResponse.model;
    response.promptFeedback = { safetyRatings: [] };

    return response;
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop':
        return FinishReason.STOP;
      case 'length':
        return FinishReason.MAX_TOKENS;
      case 'content_filter':
        return FinishReason.SAFETY;
      default:
        return FinishReason.FINISH_REASON_UNSPECIFIED;
    }
  }
}