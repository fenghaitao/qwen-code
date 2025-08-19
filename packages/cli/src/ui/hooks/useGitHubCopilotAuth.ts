/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import {
  AuthType,
  GitHubCopilotOAuth2Event,
  githubCopilotOAuth2Events,
  GitHubCopilotDeviceAuthorization,
} from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';

export interface GitHubCopilotAuthState {
  isGitHubCopilotAuthenticating: boolean;
  deviceAuth: GitHubCopilotDeviceAuthorization | null;
  authStatus:
    | 'idle'
    | 'polling'
    | 'success'
    | 'error'
    | 'timeout'
    | 'rate_limit';
  authMessage: string | null;
}

export function useGitHubCopilotAuth(
  settings: LoadedSettings,
  isAuthenticating: boolean,
) {
  const [authState, setAuthState] = useState<GitHubCopilotAuthState>({
    isGitHubCopilotAuthenticating: false,
    deviceAuth: null,
    authStatus: 'idle',
    authMessage: null,
  });

  const isGitHubCopilotAuth = settings.merged.selectedAuthType === AuthType.GITHUB_COPILOT_OAUTH;

  useEffect(() => {
    if (!isGitHubCopilotAuth || !isAuthenticating) {
      // Reset state when not authenticating or not GitHub Copilot auth
      setAuthState({
        isGitHubCopilotAuthenticating: false,
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      });
      return;
    }

    setAuthState((prev) => ({
      ...prev,
      isGitHubCopilotAuthenticating: true,
      authStatus: 'idle',
    }));

    const handleAuthUri = (deviceAuth: GitHubCopilotDeviceAuthorization) => {
      setAuthState(prev => ({
        ...prev,
        deviceAuth,
        authStatus: 'polling',
      }));
    };

    const handleAuthProgress = (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit' | 'auth_required',
      message?: string,
    ) => {
      // Special handling for auth_required status
      if (status === 'auth_required') {
        // Reset the authentication state to show the authentication menu
        setAuthState(prev => ({
          ...prev,
          isGitHubCopilotAuthenticating: false,
          authStatus: 'idle',
          authMessage: message || null,
        }));
        return;
      }
      
      setAuthState(prev => ({
        ...prev,
        authStatus: status,
        authMessage: message || null,
      }));
    };

    const handleAuthComplete = () => {
      setAuthState(prev => ({
        ...prev,
        isGitHubCopilotAuthenticating: false,
        authStatus: 'success',
        authMessage: 'Authentication completed successfully!',
      }));
    };

    const handleAuthError = (error: string) => {
      setAuthState(prev => ({
        ...prev,
        isGitHubCopilotAuthenticating: false,
        authStatus: 'error',
        authMessage: error,
      }));
    };

    // Subscribe to GitHub Copilot OAuth events
    githubCopilotOAuth2Events.on(GitHubCopilotOAuth2Event.AuthUri, handleAuthUri);
    githubCopilotOAuth2Events.on(GitHubCopilotOAuth2Event.AuthProgress, handleAuthProgress);
    githubCopilotOAuth2Events.on(GitHubCopilotOAuth2Event.AuthComplete, handleAuthComplete);
    githubCopilotOAuth2Events.on(GitHubCopilotOAuth2Event.AuthError, handleAuthError);

    return () => {
      githubCopilotOAuth2Events.off(GitHubCopilotOAuth2Event.AuthUri, handleAuthUri);
      githubCopilotOAuth2Events.off(GitHubCopilotOAuth2Event.AuthProgress, handleAuthProgress);
      githubCopilotOAuth2Events.off(GitHubCopilotOAuth2Event.AuthComplete, handleAuthComplete);
      githubCopilotOAuth2Events.off(GitHubCopilotOAuth2Event.AuthError, handleAuthError);
    };
  }, [isGitHubCopilotAuth, isAuthenticating]);

  const cancelGitHubCopilotAuth = () => {
    githubCopilotOAuth2Events.emit(GitHubCopilotOAuth2Event.AuthCancel);
    setAuthState({
      isGitHubCopilotAuthenticating: false,
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
  };

  return {
    ...authState,
    isGitHubCopilotAuth,
    cancelGitHubCopilotAuth,
  };
}