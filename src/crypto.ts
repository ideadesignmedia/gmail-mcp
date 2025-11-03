
import crypto from 'crypto';

export type KdfParams = { N: number; r: number; p: number; dkLen: number };

export async function deriveKek(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((res, rej) => {
    crypto.scrypt(password, salt, params.dkLen, { N: params.N, r: params.r, p: params.p }, (err, key) => {
      if (err) rej(err);
      else res(key as Buffer);
    });
  });
}

export function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n);
}

export function encryptAesGcm(key: Buffer, plaintext: Buffer, aad?: Buffer) {
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct, iv, tag };
}

export function decryptAesGcm(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad?: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt;
}
