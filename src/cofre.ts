import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Criptografia AES-256-GCM para dados sensíveis em repouso (arquivo .pfx e senha do certificado).
 * Formato: [iv 12 bytes][tag 16 bytes][conteúdo cifrado]
 */
export function cifrar(dado: Buffer | string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const enc = Buffer.concat([c.update(typeof dado === 'string' ? Buffer.from(dado, 'utf8') : dado), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decifrar(blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', config.masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const cifrarTexto = (t: string) => cifrar(t).toString('base64');
export const decifrarTexto = (b64: string) => decifrar(Buffer.from(b64, 'base64')).toString('utf8');
