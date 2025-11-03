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
  searchMessages,
  getMessage,
  getThread,
  getAttachment,
  modifyLabels,
  sendMessage
} from './gmail';

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
      messageId: z.string(),
      body: z.enum(['metadata', 'snippet', 'full']).optional()
    })
    .strict();
  const getThreadInput = z
    .object({
      account: z.string(),
      threadId: z.string(),
      body: z.enum(['metadata', 'full']).optional()
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
          name: 'list_accounts',
          description: 'List linked Gmail accounts',
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
          name: 'search_mail',
          description: 'Search messages by Gmail query string. If account is omitted, searches all accounts with a capped total.',
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
        if (account) {
          const acc = await getAccountByKey(db, account);
          if (!acc) throw new Error('Account not found');
          const msgs = await searchMessages(cfg, acc.id, query, limit ?? 50);
          return {
            messages: (msgs || []).map(m => ({
              accountId: acc.id,
              messageId: m.id ?? null,
              threadId: m.threadId ?? null
            }))
          };
        }
        const rows = await listAccounts(db);
        const out: Array<{ accountId: string; messageId: string | null; threadId: string | null }> = [];
        for (const acc of rows) {
          const remaining = (limit ?? 50) - out.length;
          if (remaining <= 0) break;
          const msgs = await searchMessages(cfg, acc.id, query, Math.min(remaining, 25));
          for (const m of msgs || []) {
            out.push({ accountId: acc.id, messageId: m.id ?? null, threadId: m.threadId ?? null });
            if (out.length >= (limit ?? 50)) break;
          }
          if (out.length >= (limit ?? 50)) break;
        }
        return { messages: out };
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'get_message',
          description: 'Get a single message',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              messageId: { type: 'string' },
              body: { type: 'string', enum: ['metadata', 'snippet', 'full'] }
            },
            required: ['account', 'messageId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = getMessageInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await getMessage(cfg, acc.id, input.messageId, input.body || 'metadata');
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'get_thread',
          description: 'Get a single thread',
          parameters: defineObjectSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              account: { type: 'string' },
              threadId: { type: 'string' },
              body: { type: 'string', enum: ['metadata', 'full'] }
            },
            required: ['account', 'threadId']
          } as const)
        }
      }),
      handler: async raw => {
        const input = getThreadInput.parse(raw ?? {});
        const acc = await getAccountByKey(db, input.account);
        if (!acc) throw new Error('Account not found');
        const data = await getThread(cfg, acc.id, input.threadId);
        return data as unknown as JsonValue;
      }
    },
    {
      tool: defineFunctionTool({
        type: 'function',
        function: {
          name: 'download_attachment',
          description: 'Download an attachment by messageId and attachmentId',
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
          name: 'label_message',
          description: 'Add or remove label ids on a message',
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
          name: 'send_message',
          description: 'Send an email using raw RFC822 content or fields',
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
