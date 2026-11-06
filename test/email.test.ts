import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-email-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });

test('SMTP do escritório: senha criptografada, teste e validações', async () => {
  const { criarApp } = await import('../src/server.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const { db } = await import('../src/db.js');
  const enviados: any[] = [];
  trocarTransporte(() => nodemailer.createTransport({ jsonTransport: true }) as any);
  const real = nodemailer.createTransport({ jsonTransport: true });
  const original = real.sendMail.bind(real);
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return original(m); } }) as any);

  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const s = await call('POST', '/api/setup', { escritorio: 'Contábil', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' });
    const token = s.json.token;
    assert.equal((await call('GET', '/api/email/config', undefined, token)).json, null);

    const cfg = { host: 'smtp.exemplo.com', port: 465, secure: true, usuario: 'ana@x.com', senha: 'segredo-123', remetente_nome: 'Contábil', remetente_email: 'ana@x.com' };
    assert.equal((await call('PUT', '/api/email/config', { ...cfg, remetente_email: 'invalido' }, token)).status, 400);
    assert.equal((await call('PUT', '/api/email/config', cfg, token)).status, 200);

    const lida = (await call('GET', '/api/email/config', undefined, token)).json;
    assert.equal(lida.senha, undefined, 'a senha nunca volta para a tela');
    assert.equal(lida.tem_senha, true);
    const bruto = (db.prepare('SELECT smtp_enc FROM escritorios').get() as any).smtp_enc as string;
    assert.ok(!bruto.includes('segredo-123') && !Buffer.from(bruto, 'base64').includes('segredo-123'), 'senha criptografada em repouso');

    // editar sem senha mantém a anterior
    assert.equal((await call('PUT', '/api/email/config', { ...cfg, senha: '', host: 'smtp.novo.com' }, token)).status, 200);
    assert.equal((await call('GET', '/api/email/config', undefined, token)).json.host, 'smtp.novo.com');

    assert.equal((await call('POST', '/api/email/testar', { para: 'x' }, token)).status, 400);
    assert.equal((await call('POST', '/api/email/testar', { para: 'ana@x.com' }, token)).status, 200);
    assert.equal(enviados.at(-1).to, 'ana@x.com');

    // nota inexistente / sem permissão
    assert.equal((await call('POST', '/api/notas/999/email', { para: ['a@b.com'] }, token)).status, 404);
    assert.equal((await call('POST', '/api/email/testar', { para: 'ana@x.com' })).status, 401);
  } finally { await app.close(); }
});
