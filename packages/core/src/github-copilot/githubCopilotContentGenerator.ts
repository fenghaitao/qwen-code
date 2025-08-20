/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  GenerateContentParameters,
  EmbedContentResponse,
  EmbedContentParameters,
} from '@google/genai';
import OpenAI from 'openai';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator.js';
import { Config } from '../config/config.js';
import { GitHubCopilotOAuth2Client } from './githubCopilotOAuth2.js';

/**
 * Content generator implementation for GitHub Copilot.
 *
 * This class extends `OpenAIContentGenerator` to leverage the common OpenAI
 * API format, but overrides authentication and endpoint details to work
 * specifically with the GitHub Copilot API.
 */
export class GitHubCopilotContentGenerator extends OpenAIContentGenerator {
  private static readonly COPILOT_API_BASE = 'https://api.githubcopilot.com';
  private static readonly DEFAULT_MODEL = 'gpt-4';

  constructor(
    private copilotClient: GitHubCopilotOAuth2Client,
    model: string,
    config: Config,
  ) {
    // Initialize the parent with a placeholder API key, as GitHub Copilot
    // uses a token-based authentication mechanism via `getValidAccessToken`.
    super('placeholder-api-key', model || GitHubCopilotContentGenerator.DEFAULT_MODEL, config);

    // Override the `client` property from the parent to use a custom-configured
    // OpenAI client that is tailored for GitHub Copilot's API.
    this.client = this.createCopilotClient();
  }

  /**
   * Creates a custom OpenAI client instance configured for GitHub Copilot.
   * This method sets the appropriate base URL and default headers required
   * by the Copilot API.
   */
  private createCopilotClient() {
    const version = this.config.getCliVersion() || 'unknown';
    const userAgent = `GitHubCopilotChat/0.26.7`;

    return new OpenAI({
      apiKey: 'placeholder-api-key', // Placeholder, will be replaced by getAuthHeaders
      baseURL: GitHubCopilotContentGenerator.COPILOT_API_BASE,
      defaultHeaders: {
        'User-Agent': userAgent,
        'Editor-Version': `vscode/1.99.3`,
        'Editor-Plugin-Version': `copilot-chat/0.26.7`,
      },
    });
  }

  /**
   * Overrides the `getAuthHeaders` method to provide GitHub Copilot-specific
   * authentication headers. It retrieves a valid access token from the
   * `GitHubCopilotOAuth2Client`.
   */
  protected async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.copilotClient.getValidAccessToken();
    if (!token) {
      throw new Error('GitHub Copilot authentication required. Please authenticate with GitHub Copilot first.');
    }
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Overrides the `generateContent` method to inject GitHub Copilot-specific
   * authentication headers into the request.
   */
  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const authHeaders = await this.getAuthHeaders();
    this.client.defaultHeaders = {
      ...this.client.defaultHeaders,
      ...authHeaders,
    };
    return super.generateContent(request, userPromptId);
  }

  /**
   * Overrides the `generateContentStream` method to inject GitHub Copilot-specific
   * authentication headers into the request.
   */
  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const authHeaders = await this.getAuthHeaders();
    this.client.defaultHeaders = {
      ...this.client.defaultHeaders,
      ...authHeaders,
    };
    return super.generateContentStream(request, userPromptId);
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    throw new Error('GitHub Copilot does not support embedding content');
  }
}