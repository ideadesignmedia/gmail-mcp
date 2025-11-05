
import http from 'http';
import { URL } from 'url';
import { google } from 'googleapis';

type AddOptions = {
  clientId: string;
  clientSecret: string;
  device?: boolean;
  scopes: string[];
  listenPort?: number;
};

export type OAuthResult = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
};

export async function oauthAddFlow(opts: AddOptions): Promise<OAuthResult> {
  if (opts.device) return deviceCodeFlow(opts);
  return loopbackFlow(opts);
}

async function loopbackFlow(opts: AddOptions): Promise<OAuthResult> {
  const port = opts.listenPort || 43112;
  const redirect = `http://127.0.0.1:${port}/oauth2/callback`;
  const oauth2Client = new google.auth.OAuth2(opts.clientId, opts.clientSecret, redirect);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: opts.scopes
  });

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) return;
      if (req.url.startsWith('/oauth2/callback')) {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        const c = u.searchParams.get('code');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Authentication complete. You can close this window.');
        server.close();
        if (c) resolve(c);
        else reject(new Error('Missing code'));
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.error('Please finish authentication by visiting this URL in your browser:');
      console.error(url);
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned. Ensure prompt=consent and access_type=offline, and that this is the first time granting access for this client.');
  }
  return {
    access_token: tokens.access_token || '',
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expiry_date ? Math.floor((tokens.expiry_date - Date.now()) / 1000) : undefined,
    id_token: tokens.id_token ?? undefined,
    token_type: tokens.token_type ?? undefined
  };
}

async function deviceCodeFlow(opts: AddOptions): Promise<OAuthResult> {
  const params = new URLSearchParams();
  params.set('client_id', opts.clientId);
  params.set('scope', opts.scopes.join(' '));

  const codeResp = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!codeResp.ok) throw new Error(`Device code request failed: ${codeResp.status}`);
  const codeData = await codeResp.json() as any;
  const user_code = codeData.user_code;
  const verification_url = codeData.verification_url || codeData.verification_uri;
  const device_code = codeData.device_code;
  const interval = codeData.interval || 5;

  console.log(`Please visit: ${verification_url}`);
  console.log(`Enter code: ${user_code}`);

  while (true) {
    await new Promise(r => setTimeout(r, interval * 1000));
    const tokenParams = new URLSearchParams();
    tokenParams.set('client_id', opts.clientId);
    tokenParams.set('client_secret', opts.clientSecret);
    tokenParams.set('device_code', device_code);
    tokenParams.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });
    const data = await tokenResp.json();
    if (data.error) {
      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        continue;
      }
      throw new Error(`Device flow error: ${data.error}`);
    }
    if (!data.refresh_token) throw new Error('No refresh_token in device flow result');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      id_token: data.id_token,
      token_type: data.token_type
    };
  }
}
