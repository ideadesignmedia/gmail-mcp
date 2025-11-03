#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import { openDb, pragmas, migrate, get, run, tx } from '../src/db';
import { defaultDbPath, resolveDb, resolvePass } from '../src/config';
import { isLocked, tryUnwrapDek, lockDatabase, rotatePassword } from '../src/keystore';
import { oauthAddFlow } from '../src/oauth';
import { startMcp } from '../src/mcp/server';
import crypto from 'crypto';
import { google } from 'googleapis';

const program = new Command();

program
  .name('gmail-mcp')
  .description('Private Gmail MCP server and account linker')
  .option('--db <path>', 'Path to SQLite database')
  .option('--pass <pass>', 'Database password (or use GMAIL_MCP_DB_PASS)')
  .option('--read-only', 'Disable send and modify tools', false);

program
  .command('start')
  .description('Start the MCP server over stdio')
  .action(async (_, cmd) => {
    const flags = program.opts<{ db?: string; pass?: string; readOnly?: boolean }>();
    const dbPath = resolveDb(flags);
    const pass = resolvePass(flags);
    const db = await openDb(dbPath);
    await pragmas(db);
    await migrate(db);

    const locked = await isLocked(db);
    let dek: Buffer | undefined;
    if (locked) {
      if (!pass) {
        console.error('Database is locked. Provide --pass or set GMAIL_MCP_DB_PASS.');
        process.exit(11);
      }
      try {
        const uw = await tryUnwrapDek(db, pass);
        dek = uw.dek;
      } catch (e: any) {
        console.error('Password is incorrect or database is corrupt.');
        process.exit(11);
      }
    } else {
      process.stderr.write(
        `Starting with an unlocked database at ${dbPath}. Run "gmail-mcp passwd --pass <pass>" to lock it.\n`
      );
    }
    await startMcp(db, dek, !!flags.readOnly);
  });

program
  .command('add')
  .description('Link a Gmail account via OAuth')
  .option('--client-id <id>', 'Google OAuth client id')
  .option('--client-secret <secret>', 'Google OAuth client secret')
  .option('--device', 'Use device code flow', false)
  .option('--listen-port <port>', 'Loopback port', (v) => parseInt(v, 10), 43112)
  .action(async (opts) => {
    const flags = program.opts<{ db?: string; pass?: string }>();
    const dbPath = resolveDb(flags);
    const pass = resolvePass(flags);
    const db = await openDb(dbPath);
    await pragmas(db);
    await migrate(db);

    const locked = await isLocked(db);
    let dek: Buffer | undefined;
    if (locked) {
      if (!pass) {
        console.error('Database is locked. Provide --pass or set GMAIL_MCP_DB_PASS.');
        process.exit(11);
      }
      try {
        const uw = await tryUnwrapDek(db, pass);
        dek = uw.dek;
      } catch {
        console.error('Password is incorrect or database is corrupt.');
        process.exit(11);
      }
    }

    const clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = opts.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error('Missing --client-id/--client-secret or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.');
      process.exit(2);
    }

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'openid', 'email', 'profile'
    ];

    const tokens = await oauthAddFlow({
      clientId,
      clientSecret,
      device: !!opts.device,
      scopes,
      listenPort: opts.listenPort
    });

    const oauth2 = google.oauth2('v2');
    const authClient = new google.auth.OAuth2(clientId, clientSecret);
    authClient.setCredentials({ access_token: tokens.access_token });
    const me = await oauth2.userinfo.get({ auth: authClient });
    const email = me.data.email || '';
    const googleUserId = me.data.id || '';

    if (!email || !googleUserId) {
      console.error('Failed to fetch user profile email and id');
      process.exit(3);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const scopes_json = JSON.stringify(scopes);

    await tx(db, async () => {
      await run(db, `INSERT INTO accounts(id,google_user_id,email,display_name,scopes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
        [id, googleUserId, email, me.data.name || null, scopes_json, now, now]);
      if (locked && dek) {
        const aad = Buffer.from(`credentials.refresh_token:${id}:v1`);
        const { encryptAesGcm } = await import('../src/crypto');
        const enc = encryptAesGcm(dek, Buffer.from(tokens.refresh_token, 'utf8'), aad);
        await run(db, `INSERT INTO credentials(account_id, refresh_token, refresh_token_ct, refresh_token_iv, refresh_token_tag, token_version) VALUES(?,?,?,?,?,1)`,
          [id, null, enc.ct, enc.iv, enc.tag]);
      } else {
        await run(db, `INSERT INTO credentials(account_id, refresh_token, token_version) VALUES(?,?,1)`, [id, tokens.refresh_token]);
      }
    });

    console.log(`Linked account: ${email}`);
  });

program
  .command('list')
  .description('List linked accounts')
  .action(async () => {
    const flags = program.opts<{ db?: string; pass?: string }>();
    const dbPath = resolveDb(flags);
    const pass = resolvePass(flags);
    const db = await openDb(dbPath);
    await pragmas(db);
    await migrate(db);

    const locked = await isLocked(db);
    if (locked) {
      if (!pass) {
        console.error('Database is locked. Provide --pass or set GMAIL_MCP_DB_PASS.');
        process.exit(11);
      }
      try { await tryUnwrapDek(db, pass); } catch {
        console.error('Password is incorrect or database is corrupt.');
        process.exit(11);
      }
    }

    const rows = await new Promise<any[]>((res, rej) => (db as any).all('SELECT id,email,display_name,created_at FROM accounts ORDER BY email', [], (e: any, r: any[]) => e ? rej(e) : res(r)));
    for (const r of rows) {
      const created = new Date(r.created_at).toISOString();
      console.log(`${r.id}\t${r.email}\t${r.display_name || ''}\t${created}`);
    }
  });

program
  .command('remove')
  .description('Remove an account and its tokens')
  .argument('<key>', 'email or id')
  .action(async (key) => {
    const flags = program.opts<{ db?: string; pass?: string }>();
    const dbPath = resolveDb(flags);
    const pass = resolvePass(flags);
    const db = await openDb(dbPath);
    await pragmas(db);
    await migrate(db);

    const locked = await isLocked(db);
    if (locked) {
      if (!pass) {
        console.error('Database is locked. Provide --pass or set GMAIL_MCP_DB_PASS.');
        process.exit(11);
      }
      try { await tryUnwrapDek(db, pass); } catch {
        console.error('Password is incorrect or database is corrupt.');
        process.exit(11);
      }
    }

    await tx(db, async () => {
      await run(db, 'DELETE FROM accounts WHERE id=? OR email=?', [key, key]);
    });
    console.log(`Removed: ${key}`);
  });

program
  .command('passwd')
  .description('Lock the database with a password or rotate the existing password')
  .option('--hint <text>', 'Optional password hint')
  .option('--rotate', 'Rotate password', false)
  .option('--old-pass <old>', 'Old password for rotation')
  .action(async (opts) => {
    const flags = program.opts<{ db?: string; pass?: string }>();
    const dbPath = resolveDb(flags);
    const pass = resolvePass(flags);
    const db = await openDb(dbPath);
    await pragmas(db);
    await migrate(db);

    const locked = await isLocked(db);

    if (opts.rotate || locked) {
      if (!opts.rotate) {
        opts.rotate = true;
        opts.oldPass = pass;
      }
      if (!opts.oldPass) {
        console.error('Rotation requires --old-pass');
        process.exit(2);
      }
      const newPass = flags.pass || process.env.GMAIL_MCP_DB_PASS;
      if (!newPass) {
        console.error('Provide new password with --pass or GMAIL_MCP_DB_PASS for rotation');
        process.exit(2);
      }
      await rotatePassword(db, opts.oldPass, newPass, opts.hint);
      console.log('Password rotated');
    } else {
      const newPass = flags.pass || process.env.GMAIL_MCP_DB_PASS;
      if (!newPass) {
        console.error('Provide password with --pass or GMAIL_MCP_DB_PASS to lock the database');
        process.exit(2);
      }
      await lockDatabase(db, newPass, opts.hint);
      console.log('Database locked');
    }
  });

program.parseAsync().catch(e => {
  console.error(e?.message || e);
  process.exit(1);
});
