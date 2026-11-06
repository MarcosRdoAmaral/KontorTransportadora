import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('avatar do usuário: escolher, voltar às iniciais e recusar valor inválido', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-av-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, json: r.json() }; };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    assert.equal((await call('GET', '/api/me', undefined, t)).json.avatar, null);
    assert.equal((await call('PUT', '/api/me/avatar', { avatar: 'raposa' }, t)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, t)).json.avatar, 'raposa');
    assert.equal((await call('PUT', '/api/me/avatar', { avatar: '<svg onload=x>' }, t)).status, 400);
    assert.equal((await call('PUT', '/api/me/avatar', { avatar: null }, t)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, t)).json.avatar, null);
  } finally { await app.close(); }
});
