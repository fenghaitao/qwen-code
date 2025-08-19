/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { Config } from '../config/config.js';
import open from 'open';

// GitHub OAuth Endpoints
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_API_KEY_URL = "https://api.github.com/copilot_internal/v2/token";

// File System Configuration
const GITHUB_COPILOT_DIR = '.qwen/github_copilot';
const GITHUB_COPILOT_CREDENTIAL_FILENAME = 'oauth_creds.json';

// Token Configuration
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds

/**
 * GitHub OAuth device code response interface
 */
export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * GitHub OAuth access token response interface
 */
export interface GitHubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * GitHub Copilot API token response interface
 */
export interface GitHubCopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints: {
    api: string;
  };
}

/**
 * GitHub Copilot OAuth2 credentials interface
 */
export interface GitHubCopilotOAuth2Credentials {
  access_token: string; // GitHub OAuth token
  copilot_token?: string; // Copilot API token
  copilot_expires_at?: number; // Copilot token expiry timestamp
  created_at: number;
  updated_at: number;
}

/**
 * GitHub Copilot OAuth2 device authorization interface
 */
export interface GitHubCopilotDeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/**
 * GitHub Copilot OAuth2 client interface
 */
export interface IGitHubCopilotOAuth2Client {
  getCredentialsPath(): string;
  hasValidCredentials(): Promise<boolean>;
  getValidAccessToken(): Promise<string | null>;
  startDeviceAuthorization(): Promise<GitHubCopilotDeviceAuthorization>;
  pollForAccessToken(deviceCode: string): Promise<'complete' | 'pending' | 'failed'>;
  clearCredentials(): Promise<void>;
}

/**
 * GitHub Copilot OAuth2 client implementation
 */
export class GitHubCopilotOAuth2Client implements IGitHubCopilotOAuth2Client {
  private credentialsPath: string;

  constructor(private config: Config) {
    const homeDir = os.homedir();
    const githubCopilotDir = path.join(homeDir, ...GITHUB_COPILOT_DIR.split('/'));
    this.credentialsPath = path.join(githubCopilotDir, GITHUB_COPILOT_CREDENTIAL_FILENAME);
  }

  getCredentialsPath(): string {
    return this.credentialsPath;
  }

  private async ensureCredentialsDirectory(): Promise<void> {
    const dir = path.dirname(this.credentialsPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async loadCredentials(): Promise<GitHubCopilotOAuth2Credentials | null> {
    try {
      const data = await fs.readFile(this.credentialsPath, 'utf8');
      return JSON.parse(data) as GitHubCopilotOAuth2Credentials;
    } catch {
      return null;
    }
  }

  private async saveCredentials(credentials: GitHubCopilotOAuth2Credentials): Promise<void> {
    await this.ensureCredentialsDirectory();
    await fs.writeFile(this.credentialsPath, JSON.stringify(credentials, null, 2));
    await fs.chmod(this.credentialsPath, 0o600);
  }

  async hasValidCredentials(): Promise<boolean> {
    console.log('Checking credentials at path:', this.credentialsPath);
    const credentials = await this.loadCredentials();
    console.log('Loaded credentials:', credentials ? 'found' : 'not found');
    
    if (!credentials?.access_token) {
      console.log('No access token found');
      return false;
    }

    // Check if we have a valid Copilot token
    if (credentials.copilot_token && credentials.copilot_expires_at) {
      const now = Date.now();
      const isValid = credentials.copilot_expires_at > now + TOKEN_REFRESH_BUFFER_MS;
      console.log('Copilot token valid:', isValid);
      return isValid;
    }

    // If we have GitHub token but no Copilot token, we still have valid credentials
    // The Copilot token will be obtained when needed
    console.log('Have GitHub token but no Copilot token');
    return true;
  }

  async getValidAccessToken(): Promise<string | null> {
    let credentials = await this.loadCredentials();
    
    // If we don't have any credentials, trigger the OAuth flow
    if (!credentials?.access_token) {
      console.log('No GitHub Copilot credentials found, triggering OAuth flow');
      // Emit an event to notify the UI that authentication is needed
      githubCopilotOAuth2Events.emit(
        GitHubCopilotOAuth2Event.AuthProgress,
        'auth_required',
        'Authentication required. Please complete the GitHub Copilot OAuth flow.',
      );
      return null;
    }

    // Check if we have a valid Copilot token
    if (credentials.copilot_token && credentials.copilot_expires_at) {
      const now = Date.now();
      if (credentials.copilot_expires_at > now + TOKEN_REFRESH_BUFFER_MS) {
        return credentials.copilot_token;
      }
    }

    // Try to get a new Copilot token using the GitHub OAuth token
    try {
      const copilotToken = await this.getCopilotToken(credentials.access_token!);
      if (copilotToken) {
        // Update credentials with new Copilot token
        const updatedCredentials: GitHubCopilotOAuth2Credentials = {
          ...credentials,
          copilot_token: copilotToken.token,
          copilot_expires_at: copilotToken.expires_at * 1000,
          updated_at: Date.now(),
        };
        await this.saveCredentials(updatedCredentials);
        return copilotToken.token;
      }
    } catch (error) {
      console.error('Failed to get Copilot token:', error);
    }

    return null;
  }

  private async getCopilotToken(githubToken: string): Promise<GitHubCopilotTokenResponse | null> {
    const response = await fetch(GITHUB_COPILOT_API_KEY_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'Editor-Version': 'vscode/1.99.3',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get Copilot token: ${response.status} ${response.statusText}`);
    }

    return await response.json() as GitHubCopilotTokenResponse;
  }

  async startDeviceAuthorization(): Promise<GitHubCopilotDeviceAuthorization> {
    const response = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'read:user',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to start device authorization: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as GitHubDeviceCodeResponse;
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval: data.interval || 5,
      expires_in: data.expires_in,
    };
  }

  async pollForAccessToken(deviceCode: string): Promise<'complete' | 'pending' | 'failed'> {
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      return 'failed';
    }

    const data = await response.json() as GitHubAccessTokenResponse;

    if (data.access_token) {
      // Save the GitHub OAuth token
      const credentials: GitHubCopilotOAuth2Credentials = {
        access_token: data.access_token,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await this.saveCredentials(credentials);
      return 'complete';
    }

    if (data.error === 'authorization_pending') {
      return 'pending';
    }

    return 'failed';
  }

  async clearCredentials(): Promise<void> {
    try {
      await fs.unlink(this.credentialsPath);
    } catch {
      // File doesn't exist, which is fine
    }
  }
}

/**
 * GitHub Copilot OAuth2 events
 */
export enum GitHubCopilotOAuth2Event {
  AuthUri = 'auth_uri',
  AuthProgress = 'auth_progress',
  AuthComplete = 'auth_complete',
  AuthCancel = 'auth_cancel',
  AuthError = 'auth_error',
}

/**
 * Global event emitter instance for GitHub Copilot OAuth2 authentication events
 */
export const githubCopilotOAuth2Events = new EventEmitter();

export async function getGitHubCopilotOAuthClient(
  config: Config,
): Promise<GitHubCopilotOAuth2Client> {
  console.log('getGitHubCopilotOAuthClient called');
  const client = new GitHubCopilotOAuth2Client(config);
  
  // Check if we have valid credentials, and if not, trigger the OAuth flow
  // This makes the behavior consistent with Qwen authentication
  if (!(await client.hasValidCredentials())) {
    console.log('No valid GitHub Copilot credentials found, will trigger OAuth flow');
    // We don't automatically trigger the OAuth flow here like Qwen does,
    // but we'll ensure the UI handles this case properly
  }
  
  console.log('GitHub Copilot OAuth client initialized');
  return client;
}

async function performGitHubCopilotOAuthFlow(
  client: GitHubCopilotOAuth2Client,
  config: Config,
): Promise<'complete' | 'timeout' | 'cancelled' | 'rate_limited' | 'failed'> {
  let cancelHandler: () => void;
  let timeoutId: NodeJS.Timeout;

  const cleanup = () => {
    githubCopilotOAuth2Events.off(GitHubCopilotOAuth2Event.AuthCancel, cancelHandler);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  try {
    // Set up cancellation handler
    cancelHandler = () => {
      cleanup();
    };
    githubCopilotOAuth2Events.once(GitHubCopilotOAuth2Event.AuthCancel, cancelHandler);

    console.log('Starting GitHub Copilot device authorization...');
    // Start device authorization
    const deviceAuth = await client.startDeviceAuthorization();
    console.log('Device authorization successful:', deviceAuth);

    // Emit the authorization URI for the UI to handle
    githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthUri, deviceAuth);

    const showFallbackMessage = () => {
      console.log('\n=== GitHub Copilot OAuth Device Authorization ===');
      console.log(`Please visit: ${deviceAuth.verification_uri}`);
      console.log(`And enter the code: ${deviceAuth.user_code}`);
      console.log('Waiting for authorization...\n');
    };

    // If browser launch is not suppressed, try to open the URL
    if (!config.isBrowserLaunchSuppressed()) {
      try {
        const childProcess = await open(deviceAuth.verification_uri);

        // IMPORTANT: Attach an error handler to the returned child process.
        // Without this, if `open` fails to spawn a process (e.g., `xdg-open` is not found
        // in a minimal Docker container), it will emit an unhandled 'error' event,
        // causing the entire Node.js process to crash.
        if (childProcess) {
          childProcess.on('error', () => {
            console.log('Failed to open browser. Visit this URL to authorize:');
            showFallbackMessage();
          });
        }
      } catch (_err) {
        showFallbackMessage();
      }
    } else {
      // Browser launch is suppressed, show fallback message
      showFallbackMessage();
    }

    // Set up timeout
    const timeoutMs = deviceAuth.expires_in * 1000;
    timeoutId = setTimeout(() => {
      githubCopilotOAuth2Events.emit(
        GitHubCopilotOAuth2Event.AuthProgress,
        'timeout',
        'Authentication timed out',
      );
    }, timeoutMs);

    // Start polling
    const pollInterval = deviceAuth.interval * 1000;
    let attempts = 0;
    const maxAttempts = Math.floor(timeoutMs / pollInterval);

    while (attempts < maxAttempts) {
      try {
        githubCopilotOAuth2Events.emit(
          GitHubCopilotOAuth2Event.AuthProgress,
          'polling',
          `Polling for authorization... (${attempts + 1}/${maxAttempts})`,
        );

        const result = await client.pollForAccessToken(deviceAuth.device_code);
        console.log('Poll result:', result);

        if (result === 'complete') {
          githubCopilotOAuth2Events.emit(
            GitHubCopilotOAuth2Event.AuthProgress,
            'success',
            'Authentication successful!',
          );

          githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthComplete);
          cleanup();
          return 'complete';
        }

        if (result === 'failed') {
          githubCopilotOAuth2Events.emit(
            GitHubCopilotOAuth2Event.AuthProgress,
            'error',
            'Authentication failed',
          );
          cleanup();
          return 'failed';
        }

        // result === 'pending', continue polling
        attempts++;
        
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        
        if (message.includes('rate limit') || message.includes('too many requests')) {
          githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthProgress, 'error', message);
          cleanup();
          return 'rate_limited';
        }

        githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthProgress, 'error', message);
        cleanup();
        return 'failed';
      }
    }

    // Timeout reached
    githubCopilotOAuth2Events.emit(
      GitHubCopilotOAuth2Event.AuthProgress,
      'timeout',
      'Authentication timed out',
    );
    cleanup();
    return 'timeout';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthError, message);
    cleanup();
    return 'failed';
  } finally {
    cleanup();
  }
}

async function refreshGitHubCopilotToken(
  client: GitHubCopilotOAuth2Client,
  config: Config,
): Promise<string | null> {
  return await client.getValidAccessToken();
}