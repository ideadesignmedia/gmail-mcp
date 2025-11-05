import {
  defineFunctionTool,
  defineObjectSchema,
  type McpToolHandlerOptions,
  type JsonValue
} from '@ideadesignmedia/open-ai.js';
import { z } from 'zod';
import type { DB } from './db';
import {
  GmailConfig,
  listAccounts,
  getAccountByKey,
  searchMessagesSimple,
  getMessageSimple,
  getThreadSimple,
  getAttachment,
  modifyLabels,
  sendMessage
} from './gmail';

function isDateOnlyQuery(q: string): boolean {
  const s = (q || '').trim();
  if (!s.length) return true;
  const tokens = s.split(/\s+/);
  const allowed = /^(after|before|older_than|newer_than):\S+$/i;
  for (let t of tokens) {
    // Strip simple wrappers/negation
    t = t.replace(/[()]/g, '');
    if (t === '' || t.toUpperCase() === 'OR' || t.toUpperCase() === 'AND') continue;
    if (t.startsWith('-')) t = t.slice(1);
    if (!allowed.test(t)) return false;
  }
  return true;
}

export function buildTools(db: DB, dek: Buffer | undefined, readOnly = false): McpToolHandlerOptions[] {
  const cfg: GmailConfig = { db, dek, readOnly };

  const listAccountsInput = z.object({}).strict();
  const searchMailInput = z
    .object({
      query: z.string(),
      account: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional()
    })
    .strict();
  const getMessageInput = z
    .object({
      account: z.string(),
      messageId: z.string()
    })
    .strict();
  const getThreadInput = z
    .object({
      account: z.string(),
      threadId: z.string()
    })
    .strict();
  const downloadAttachmentInput = z
    .object({
      account: z.string(),
      messageId: z.string(),
      attachmentId: z.string()
    })
    .strict();
  const labelMessageInput = z
    .object({
      account: z.string(),
      messageId: z.string(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional()
    })
    .strict();
  const sendMessageInput = z
    .object({
      account: z.string(),
      to: z.string(),
      subject: z.string(),
      text: z.string().optional(),
      html: z.string().optional(),
      replyToMessageId: z.string().optional()
    })
    .strict();

  const tools: McpToolHandlerOptions[] = [
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-list_accounts',
          description: 'List linked Gmail accounts (id, email, displayName). Use id or email in other tools.',
          parameters: defineObjectSchema({
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false
          } as const)
        }
      }),
      handler: async input => {
        listAccountsInput.parse(input ?? {});
        const rows = await listAccounts(db);
        return { accounts: rows.map(r => ({ id: r.id, email: r.email, displayName: r.display_name || null })) };
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-search_mail',
          description: 'Search Gmail with a query string (supports native operators like: from:, to:, subject:, label:, in:, is:, has:, before:, after:, older_than:, newer_than:, cc:, bcc:, filename:, larger:/smaller:, OR, and - for negation). Returns enriched results: accountId, accountEmail, messageId, threadId, subject, snippet, from, to, cc, bcc, timestamp, date, labels (id+name). Use gmail-get_message for full body and attachments.',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              account: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 200 }
            },
            required: ['query']
          } as const)
        }
      }),
      handler: async raw => {
        const input = searchMailInput.parse(raw ?? {});
        const { query, account, limit } = input;
        const cap = limit ?? 50;
        const dateOnly = isDateOnlyQuery(query);
        if (account) {
          const acc = await getAccountByKey(db, account);
          if (!acc) throw new Error('Account not found');
          const msgs = await searchMessagesSimple(cfg, acc.id, acc.email, query, cap);
          // Sorting: if purely date-based query, sort by most recent; else preserve Gmail order
          const outMsgs = dateOnly ? [...msgs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) : msgs;
          return { messages: outMsgs } as unknown as JsonValue;
        }
        const rows = await listAccounts(db);
        const out: any[] = [];
        for (const acc of rows) {
          const remaining = cap - out.length;
          if (remaining <= 0) break;
          const per = Math.min(remaining, 25);
          const msgs = await searchMessagesSimple(cfg, acc.id, acc.email, query, per);
          for (const m of msgs) {
            out.push(m);
            if (out.length >= cap) break;
          }
          if (out.length >= cap) break;
        }
        // Sorting across accounts: if date-only query, sort by most recent; else preserve per-account order
        if (dateOnly) out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return { messages: out } as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-get_message',
          description: 'Get a single message as a simple, human-readable object: id, thread, labels, subject, body (decoded), from, to, cc, bcc, attachments.',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              messageId: { type: 'string' }
            },
            required: ['account', 'messageId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = getMessageInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await getMessageSimple(cfg, acc.id, input.messageId);
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-get_thread',
          description: 'Get a thread by threadId with deduped, simplified messages (id, thread, labels with names, timestamp, subject, body, from, to, cc, bcc, attachments).',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              threadId: { type: 'string' }
            },
            required: ['account', 'threadId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = getThreadInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await getThreadSimple(cfg, acc.id, input.threadId);
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-download_attachment',
          description: 'Download an attachment by messageId and attachmentId. Returns base64url data and metadata from Gmail.',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              messageId: { type: 'string' },
              attachmentId: { type: 'string' }
            },
            required: ['account', 'messageId', 'attachmentId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = downloadAttachmentInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await getAttachment(cfg, acc.id, input.messageId, input.attachmentId);
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-label_message',
          description: 'Add or remove Gmail label IDs on a message. Provide labelIds to add/remove. Disabled in read-only mode.',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              messageId: { type: 'string' },
              add: { type: 'array', items: { type: 'string' } },
              remove: { type: 'array', items: { type: 'string' } }
            },
            required: ['account', 'messageId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = labelMessageInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await modifyLabels(cfg, acc.id, input.messageId, input.add ?? [], input.remove ?? []);
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'gmail-send_message',
          description: 'Send an email. Provide to, subject, and text or html body. Replies do not yet set threading headers.',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              to: { type: 'string' },
              subject: { type: 'string' },
              text: { type: 'string' },
              html: { type: 'string' },
              replyToMessageId: { type: 'string' }
            },
            required: ['account', 'to', 'subject']
          } as const)
        }
      }),
      handler: async raw => {
        if (cfg.readOnly) throw new Error('Server is in read-only mode');
        const input = sendMessageInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const rawRfc822 = buildRfc822(input.to, input.subject, input.text, input.html);
        const data = await sendMessage(cfg, acc.id, rawRfc822);
        return data as unknown as JsonValue;
      }
    }
  ];

  return tools;
}

function buildRfc822(to: string, subject: string, text?: string, html?: string): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    html ? `Content-Type: text/html; charset="UTF-8"` : `Content-Type: text/plain; charset="UTF-8"`
  ].join('\r\n');
  const body = html ?? text ?? '';
  return `${headers}\r\n\r\n${body}`;
}
