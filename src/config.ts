
import os from 'os';
import path from 'path';

export function defaultDbPath(): string {
  const home = os.homedir();
  return path.join(home, '.idm', 'gmail-mcp', 'db.sqlite');
}

export type GlobalFlags = {
  db?: string;
  pass?: string;
  readOnly?: boolean;
};

export function resolveDb(flags: GlobalFlags): string {
  return flags.db && flags.db.length ? flags.db : defaultDbPath();
}

export function resolvePass(flags: GlobalFlags): string | undefined {
  return flags.pass || process.env.GMAIL_MCP_DB_PASS;
}
