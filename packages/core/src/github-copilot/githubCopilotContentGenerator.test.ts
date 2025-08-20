/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubCopilotContentGenerator } from './githubCopilotContentGenerator.js';
import { GitHubCopilotOAuth2Client } from './githubCopilotOAuth2.js';
import { Config } from '../config/config.js';
import OpenAI from 'openai';
import { GenerateContentParameters } from '@google/genai';

// Mock the dependencies
vi.mock('./githubCopilotOAuth2.js');
vi.mock('openai');

describe('GitHubCopilotContentGenerator', () => {
  let mockCopilotClient: vi.Mocked<GitHubCopilotOAuth2Client>;
  let mockConfig: Config;
  let generator: GitHubCopilotContentGenerator;
  let mockOpenAIInstance: any;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Mock GitHubCopilotOAuth2Client
    mockCopilotClient = new GitHubCopilotOAuth2Client({} as any) as vi.Mocked<GitHubCopilotOAuth2Client>;
    mockCopilotClient.getValidAccessToken = vi.fn().mockResolvedValue('test-access-token');

    // Mock Config
    mockConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    // Mock OpenAI instance
    mockOpenAIInstance = {
        chat: {
            completions: {
                create: vi.fn().mockResolvedValue({
                    id: 'test-id',
                    choices: [{ message: { content: 'test-response' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            },
        },
        defaultHeaders: {},
    };

    // Whenever OpenAI is instantiated, return our mock instance
    (OpenAI as vi.Mock).mockReturnValue(mockOpenAIInstance);

    // Create an instance of the generator
    generator = new GitHubCopilotContentGenerator(mockCopilotClient, 'gpt-4', mockConfig);
  });

  it('should initialize the OpenAI client with the correct Copilot API base URL and headers', () => {
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'placeholder-api-key',
      baseURL: 'https://api.githubcopilot.com',
      defaultHeaders: {
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'Editor-Version': 'vscode/1.99.3',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
    });
  });

  it('should call getValidAccessToken and set auth headers for generateContent', async () => {
    const request: GenerateContentParameters = { contents: [{ role: 'user', parts: [{text: 'hello'}] }] };

    await generator.generateContent(request, 'prompt-id');

    expect(mockCopilotClient.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(mockOpenAIInstance.defaultHeaders['Authorization']).toBe('Bearer test-access-token');
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('should call getValidAccessToken and set auth headers for generateContentStream', async () => {
    const request: GenerateContentParameters = { contents: [{ role: 'user', parts: [{text: 'hello'}] }] };

    // Mock the streaming response
    const mockStream = (async function* () {
      yield {
        id: 'test-id',
        choices: [{ delta: { content: 'test-stream-response' }, finish_reason: 'stop' }],
      };
    })();
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockStream);

    const stream = await generator.generateContentStream(request, 'prompt-id');
    await stream.next(); // Consume one item from the stream

    expect(mockCopilotClient.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(mockOpenAIInstance.defaultHeaders['Authorization']).toBe('Bearer test-access-token');
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if access token is not available', async () => {
    mockCopilotClient.getValidAccessToken.mockResolvedValue(null);
    const request: GenerateContentParameters = { contents: [{ role: 'user', parts: [{text: 'hello'}] }] };

    await expect(generator.generateContent(request, 'prompt-id')).rejects.toThrow(
      'GitHub Copilot authentication required. Please authenticate with GitHub Copilot first.'
    );
  });
});
