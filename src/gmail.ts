
import { google } from 'googleapis';
import { DB, get, run } from './db';
import { decryptAesGcm } from './crypto';

export type GmailConfig = {
  db: DB;
  dek?: Buffer;
  readOnly?: boolean;
};

export type AccountRow = {
  id: string;
  email: string;
  google_user_id: string;
  display_name?: string;
  scopes_json: string;
};

export async function listAccounts(db: DB): Promise<AccountRow[]> {
  const rows = await new Promise<any[]>((res, rej) => (db as any).all('SELECT id,email,google_user_id,display_name,scopes_json FROM accounts ORDER BY email', [], (e: any, r: any[]) => e ? rej(e) : res(r)));
  return rows;
}

export async function getAccountByKey(db: DB, key: string): Promise<AccountRow | undefined> {
  const row = await get<any>(db, 'SELECT id,email,google_user_id,display_name,scopes_json FROM accounts WHERE id=? OR email=?', [key, key]);
  return row;
}

export async function getGmailClient(cfg: GmailConfig, accountId: string) {
  const cred = await get<any>(cfg.db, 'SELECT refresh_token, refresh_token_ct, refresh_token_iv, refresh_token_tag, access_token, access_expires_at FROM credentials WHERE account_id=?', [accountId]);
  if (!cred) throw new Error('Account credentials not found');

  let refreshToken: string | undefined;
  if (cred.refresh_token) refreshToken = cred.refresh_token;
  else {
    if (!cfg.dek) throw new Error('Database is locked and password has not been provided');
    const aad = Buffer.from(`credentials.refresh_token:${accountId}:v1`);
    const pt = decryptAesGcm(cfg.dek, cred.refresh_token_iv, cred.refresh_token_tag, cred.refresh_token_ct, aad);
    refreshToken = pt.toString('utf8');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || '',
    process.env.GOOGLE_CLIENT_SECRET || ''
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return { gmail, oauth2Client };
}

export async function searchMessages(cfg: GmailConfig, accountId: string, q: string, maxResults = 50) {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults
  });
  return resp.data.messages || [];
}

export async function getMessage(cfg: GmailConfig, accountId: string, id: string, format: 'metadata'|'snippet'|'full' = 'metadata') {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: format === 'snippet' ? 'full' : format
  });
  return resp.data;
}

export async function getThread(cfg: GmailConfig, accountId: string, id: string) {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.threads.get({ userId: 'me', id });
  return resp.data;
}

export async function modifyLabels(cfg: GmailConfig, accountId: string, id: string, add: string[] = [], remove: string[] = []) {
  if (cfg.readOnly) throw new Error('Server is in read-only mode');
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: { addLabelIds: add, removeLabelIds: remove }
  });
  return resp.data;
}

export async function sendMessage(cfg: GmailConfig, accountId: string, rawRfc822: string) {
  if (cfg.readOnly) throw new Error('Server is in read-only mode');
  const { gmail } = await getGmailClient(cfg, accountId);
  const encoded = Buffer.from(rawRfc822, 'utf8').toString('base64url');
  const resp = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded }
  });
  return resp.data;
}

export async function getAttachment(cfg: GmailConfig, accountId: string, messageId: string, attachmentId: string) {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId
  });
  return resp.data;
}
