
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

export type SimpleSearchMessage = {
  accountId: string;
  accountEmail: string;
  messageId: string;
  threadId: string;
  subject: string | null;
  snippet: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  timestamp: number;
  date: string;
  labels: Array<{ id: string; name: string }>;
};

export async function searchMessagesSimple(cfg: GmailConfig, accountId: string, accountEmail: string, q: string, limit = 50): Promise<SimpleSearchMessage[]> {
  const { gmail } = await getGmailClient(cfg, accountId);
  const labelMap = await getLabelNameMap(cfg, accountId);
  const out: SimpleSearchMessage[] = [];
  let pageToken: string | undefined = undefined;
  while (out.length < limit) {
    const need = Math.min(limit - out.length, 100);
    const resp: any = await gmail.users.messages.list({ userId: 'me', q, maxResults: need, pageToken });
    const items = resp.data.messages || [];
    if (!items.length) break;
    // Fetch metadata for each returned id
    for (const m of items) {
      if (!m.id) continue;
      try {
        const md = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Bcc', 'Date']
        });
        const msg: any = md.data;
        const headers = msg?.payload?.headers as Array<{ name?: string; value?: string }> | undefined;
        const ts = typeof msg.internalDate === 'string' ? parseInt(msg.internalDate, 10) : (msg.internalDate || 0);
        const labels = (Array.isArray(msg.labelIds) ? msg.labelIds : []).map((lid: string) => ({ id: lid, name: labelMap.get(lid) || lid }));
        out.push({
          accountId,
          accountEmail,
          messageId: msg.id || m.id,
          threadId: msg.threadId || (m.threadId || ''),
          subject: headerValue(headers, 'Subject'),
          snippet: (msg.snippet as string) || '',
          from: headerValue(headers, 'From'),
          to: headerValue(headers, 'To'),
          cc: headerValue(headers, 'Cc'),
          bcc: headerValue(headers, 'Bcc'),
          timestamp: Number.isFinite(ts) ? ts : 0,
          date: new Date(Number.isFinite(ts) ? ts : 0).toISOString(),
          labels
        });
      } catch {
        // skip individual failures
      }
      if (out.length >= limit) break;
    }
    pageToken = resp.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
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

// Simplified message shape for LLM-friendly consumption
export type SimpleAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
};

export type SimpleMessage = {
  id: string;
  thread: string;
  labels: Array<{ id: string; name: string }>;
  timestamp: number;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  body: string;
  bodyType: 'text' | 'html';
  attachments: SimpleAttachment[];
};

function base64UrlDecode(data?: string | null): string | null {
  if (!data) return null;
  try {
    // Gmail uses base64url without padding
    const pad = data.length % 4 === 2 ? '==' : data.length % 4 === 3 ? '=' : '';
    const s = data.replace(/-/g, '+').replace(/_/g, '/') + pad;
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function decodeMimeWords(input: string | undefined | null): string | null {
  if (!input) return null;
  // Basic RFC 2047 encoded-word decoding: =?charset?B?...?= or =?charset?Q?...?=
  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_m: string, _cs: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(data, 'base64').toString('utf8');
      } else {
        const txt = data.replace(/_/g, ' ');
        return txt.replace(/=([0-9A-Fa-f]{2})/g, (_m2: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
    } catch {
      return input;
    }
  });
}

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | null {
  const h = headers?.find(h => (h.name || '').toLowerCase() === name.toLowerCase());
  return decodeMimeWords(h?.value) ?? (h?.value ?? null);
}

function walkParts(parts: any[] | undefined, out: { text?: string; html?: string; attachments: SimpleAttachment[] }) {
  if (!parts) return;
  for (const p of parts) {
    const mime = p.mimeType || '';
    const filename = p.filename || '';
    // Body data
    if (mime === 'text/plain' && p.body?.data) {
      out.text = out.text ?? base64UrlDecode(p.body.data) ?? undefined;
    } else if (mime === 'text/html' && p.body?.data) {
      out.html = out.html ?? base64UrlDecode(p.body.data) ?? undefined;
    }
    // Attachments
    if (filename && p.body?.attachmentId) {
      out.attachments.push({
        filename,
        mimeType: mime || 'application/octet-stream',
        size: typeof p.body?.size === 'number' ? p.body.size : 0,
        attachmentId: p.body.attachmentId
      });
    }
    // Recurse
    if (p.parts && Array.isArray(p.parts)) walkParts(p.parts, out);
  }
}

export async function getMessageSimple(cfg: GmailConfig, accountId: string, id: string): Promise<SimpleMessage> {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const m = resp.data as any;

  const headers = m?.payload?.headers as Array<{ name?: string; value?: string }> | undefined;
  const collector: { text?: string; html?: string; attachments: SimpleAttachment[] } = { attachments: [] };

  // Single-part body
  const topMime = m?.payload?.mimeType;
  const topData = m?.payload?.body?.data;
  if (topData && (topMime === 'text/plain' || topMime === 'text/html')) {
    if (topMime === 'text/plain') collector.text = base64UrlDecode(topData) ?? undefined;
    else collector.html = base64UrlDecode(topData) ?? undefined;
  }
  // Walk parts for text/html and attachments
  if (Array.isArray(m?.payload?.parts)) {
    walkParts(m.payload.parts, collector);
  }

  const body = collector.text ?? collector.html ?? '';
  const bodyType: 'text' | 'html' = collector.text ? 'text' : 'html';
  const labelMap = await getLabelNameMap(cfg, accountId);
  const labels = (Array.isArray(m.labelIds) ? m.labelIds : []).map((id: string) => ({ id, name: labelMap.get(id) || id }));
  const timestamp = typeof m.internalDate === 'string' ? parseInt(m.internalDate, 10) : (m.internalDate || 0);

  return {
    id: m.id || id,
    thread: m.threadId || '',
    labels,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    subject: headerValue(headers, 'Subject'),
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    bcc: headerValue(headers, 'Bcc'),
    body,
    bodyType,
    attachments: collector.attachments
  };
}

// Cache label id->name per account to minimize repeated API calls
const labelCache = new Map<string, { at: number; map: Map<string, string> }>();
const LABEL_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getLabelNameMap(cfg: GmailConfig, accountId: string): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = labelCache.get(accountId);
  if (cached && (now - cached.at) < LABEL_TTL_MS) return cached.map;
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.labels.list({ userId: 'me' });
  const map = new Map<string, string>();
  for (const l of resp.data.labels || []) {
    if (!l || !l.id) continue;
    map.set(l.id, l.name || l.id);
  }
  labelCache.set(accountId, { at: now, map });
  return map;
}

export type SimpleThread = {
  id: string;
  messages: SimpleMessage[];
};

export async function getThreadSimple(cfg: GmailConfig, accountId: string, threadId: string): Promise<SimpleThread> {
  const { gmail } = await getGmailClient(cfg, accountId);
  const resp = await gmail.users.threads.get({ userId: 'me', id: threadId });
  const t = resp.data as any;

  const labelMap = await getLabelNameMap(cfg, accountId);

  const seen = new Set<string>();
  const out: SimpleMessage[] = [];
  const messages: any[] = Array.isArray(t.messages) ? t.messages : [];
  for (const m of messages) {
    const id = m.id as string;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // Build simplified message without extra network calls
    const headers = m?.payload?.headers as Array<{ name?: string; value?: string }> | undefined;
    const collector: { text?: string; html?: string; attachments: SimpleAttachment[] } = { attachments: [] };

    const topMime = m?.payload?.mimeType;
    const topData = m?.payload?.body?.data;
    if (topData && (topMime === 'text/plain' || topMime === 'text/html')) {
      if (topMime === 'text/plain') collector.text = base64UrlDecode(topData) ?? undefined;
      else collector.html = base64UrlDecode(topData) ?? undefined;
    }
    if (Array.isArray(m?.payload?.parts)) walkParts(m.payload.parts, collector);

    const body = collector.text ?? collector.html ?? '';
    const bodyType: 'text' | 'html' = collector.text ? 'text' : 'html';
    const timestamp = typeof m.internalDate === 'string' ? parseInt(m.internalDate, 10) : (m.internalDate || 0);
    const labels = (Array.isArray(m.labelIds) ? m.labelIds : []).map((lid: string) => ({ id: lid, name: labelMap.get(lid) || lid }));

    out.push({
      id,
      thread: m.threadId || threadId,
      labels,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      subject: headerValue(headers, 'Subject'),
      from: headerValue(headers, 'From'),
      to: headerValue(headers, 'To'),
      cc: headerValue(headers, 'Cc'),
      bcc: headerValue(headers, 'Bcc'),
      body,
      bodyType,
      attachments: collector.attachments
    });
  }

  out.sort((a, b) => a.timestamp - b.timestamp);

  return { id: threadId, messages: out };
}
