
import { DB, get, run, tx } from './db';
import { KdfParams, deriveKek, randomBytes, encryptAesGcm, decryptAesGcm } from './crypto';

const DEFAULT_KDF: KdfParams = { N: 32768, r: 8, p: 1, dkLen: 32 };

export type UnwrappedDek = { dek: Buffer, params: KdfParams, salt: Buffer };

export async function isLocked(db: DB): Promise<boolean> {
  const row = await get<{ is_locked: number }>(db, 'SELECT is_locked FROM encryption_meta WHERE id=1');
  return !!(row && row.is_locked);
}

export async function tryUnwrapDek(db: DB, password: string): Promise<UnwrappedDek> {
  const row = await get<any>(db, 'SELECT * FROM encryption_meta WHERE id=1');
  if (!row) throw new Error('encryption_meta missing');
  if (!row.kdf_salt || !row.dek_ct) throw new Error('database is not locked');
  const params: KdfParams = row.kdf_params_json ? JSON.parse(row.kdf_params_json) : DEFAULT_KDF;
  const salt: Buffer = Buffer.from(row.kdf_salt);
  const kek = await deriveKek(password, salt, params);
  const dek = decryptAesGcm(kek, row.dek_iv, row.dek_tag, row.dek_ct);
  return { dek, params, salt };
}

export async function lockDatabase(db: DB, password: string, hint?: string) {
  await tx(db, async () => {
    const salt = randomBytes(16);
    const params = DEFAULT_KDF;
    const kek = await deriveKek(password, salt, params);
    const dek = randomBytes(32);
    const { ct: dek_ct, iv: dek_iv, tag: dek_tag } = encryptAesGcm(kek, dek);

    await run(db, 'UPDATE encryption_meta SET is_locked=1,kdf_salt=?,kdf_params_json=?,dek_ct=?,dek_iv=?,dek_tag=?,password_hint=? WHERE id=1',
      [salt, JSON.stringify(params), dek_ct, dek_iv, dek_tag, hint || null]);
  });

  const rows: Array<{ account_id: string, refresh_token: string | null }> = await new Promise((res, rej) => {
    (db as any).all('SELECT account_id, refresh_token FROM credentials WHERE refresh_token IS NOT NULL', [], (err: any, rows: any[]) => err ? rej(err) : res(rows));
  });
  const em = await get<any>(db, 'SELECT * FROM encryption_meta WHERE id=1');
  if (!em) throw new Error('encryption_meta missing after lock');
  const params: KdfParams = em.kdf_params_json ? JSON.parse(em.kdf_params_json) : DEFAULT_KDF;
  const kek = await deriveKek(password, Buffer.from(em.kdf_salt), params);
  const dek = decryptAesGcm(kek, em.dek_iv, em.dek_tag, em.dek_ct);

  await tx(db, async () => {
    for (const r of rows) {
      if (!r.refresh_token) continue;
      const aad = Buffer.from(`credentials.refresh_token:${r.account_id}:v1`);
      const enc = encryptAesGcm(dek, Buffer.from(r.refresh_token, 'utf8'), aad);
      await run(db, 'UPDATE credentials SET refresh_token=NULL, refresh_token_ct=?, refresh_token_iv=?, refresh_token_tag=?, access_token=NULL, access_expires_at=NULL WHERE account_id=?',
        [enc.ct, enc.iv, enc.tag, r.account_id]);
    }
  });
}

export async function rotatePassword(db: DB, oldPass: string, newPass: string, hint?: string) {
  const row = await get<any>(db, 'SELECT * FROM encryption_meta WHERE id=1');
  if (!row) throw new Error('encryption_meta missing');
  if (!row.is_locked) throw new Error('database is not locked');
  const oldParams: KdfParams = row.kdf_params_json ? JSON.parse(row.kdf_params_json) : DEFAULT_KDF;
  const oldSalt: Buffer = Buffer.from(row.kdf_salt);
  const oldKek = await deriveKek(oldPass, oldSalt, oldParams);
  const dek = decryptAesGcm(oldKek, row.dek_iv, row.dek_tag, row.dek_ct);

  const newSalt = randomBytes(16);
  const newParams = DEFAULT_KDF;
  const newKek = await deriveKek(newPass, newSalt, newParams);
  const { ct, iv, tag } = encryptAesGcm(newKek, dek);

  await run(db, 'UPDATE encryption_meta SET kdf_salt=?, kdf_params_json=?, dek_ct=?, dek_iv=?, dek_tag=?, password_hint=? WHERE id=1',
    [newSalt, JSON.stringify(newParams), ct, iv, tag, hint || row.password_hint || null]);
}
