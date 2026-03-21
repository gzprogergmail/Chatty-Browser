import axios from 'axios';
import open from 'open';
import { createServer } from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(process.cwd(), '.auth-cache.json');

interface AuthCache {
  token: string;
  expiresAt: number;
}

export class GitHubAuth {
  private clientId = 'Iv1.b507a08c87ecfe98'; // GitHub CLI client ID
  private scope = 'read:user';

  async authenticate(): Promise<string> {
    // Check for cached token
    const cached = await this.getCachedToken();
    if (cached) {
      return cached;
    }

    // Perform device flow authentication
    return await this.deviceFlowAuth();
  }

  private async getCachedToken(): Promise<string | null> {
    try {
      const data = await fs.readFile(CACHE_FILE, 'utf-8');
      const cache: AuthCache = JSON.parse(data);
      
      if (cache.expiresAt > Date.now()) {
        return cache.token;
      }
    } catch {
      // Cache doesn't exist or is invalid
    }
    return null;
  }

  private async saveToken(token: string) {
    const cache: AuthCache = {
      token,
      expiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000), // 1 year
    };
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  private async deviceFlowAuth(): Promise<string> {
    // Step 1: Request device code
    const deviceCodeResponse = await axios.post(
      'https://github.com/login/device/code',
      new URLSearchParams({
        client_id: this.clientId,
        scope: this.scope,
      }),
      {
        headers: { 'Accept': 'application/json' },
      }
    );

    const {
      device_code,
      user_code,
      verification_uri,
      interval = 5,
    } = deviceCodeResponse.data;

    // Step 2: Show user code and open browser
    console.log(`\n📱 Please authorize this device:`);
    console.log(`   Go to: ${verification_uri}`);
    console.log(`   Enter code: ${user_code}\n`);
    
    await open(verification_uri);

    // Step 3: Poll for authorization
    return await this.pollForToken(device_code, interval);
  }

  private async pollForToken(deviceCode: string, interval: number): Promise<string> {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));

      try {
        const response = await axios.post(
          'https://github.com/login/oauth/access_token',
          new URLSearchParams({
            client_id: this.clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          {
            headers: { 'Accept': 'application/json' },
          }
        );

        const { access_token, error } = response.data;

        if (access_token) {
          await this.saveToken(access_token);
          return access_token;
        }

        if (error === 'authorization_pending') {
          process.stdout.write('.');
          continue;
        }

        if (error === 'slow_down') {
          interval += 5;
          continue;
        }

        throw new Error(`Authentication failed: ${error}`);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 400) {
          continue;
        }
        throw error;
      }
    }
  }
}
