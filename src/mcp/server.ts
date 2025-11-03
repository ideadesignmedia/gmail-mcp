
import type { DB } from '../db';
import { buildTools } from '../tools';
import { McpServer } from '@ideadesignmedia/open-ai.js';

export async function startMcp(db: DB, dek: Buffer | undefined, readOnly = false) {
  const tools = buildTools(db, dek, readOnly);
  const server = new McpServer({
    transports: ['stdio'],
    tools,
    metadata: {
      name: 'gmail-mcp',
      description: 'Private Gmail MCP server for linked accounts'
    }
  });

  await server.start();
}
