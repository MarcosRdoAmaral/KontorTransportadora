import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Instalação "limpa", como no aplicativo de desktop: sem ADMIN_SENHA, com pasta de backup.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-setup-'));
process.env.DATABASE_PATH = path.join(tmp, 'db.sqlite');
process.env.STORAGE_DIR = path.join(tmp, 'arq');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.LICENCA_CHAVE_PUBLICA ??= ''; // sem controle de licença nos testes que cadastram vários
process.env.MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.SESSION_SECRET = 'x';
process.env.NFSE_DESKTOP = '1';
delete process.env.ADMIN_SENHA;

test('primeiro acesso, backup e duplicidade', async () => {
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload };
  };
  try {
    assert.deepEqual((await call('GET', '/api/setup/status')).json, { configurado: false, desktop: true, versao: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
    assert.equal((await call('POST', '/api/login', { email: 'a@b.com', senha: 'qualquer-coisa' })).status, 401);
    assert.equal((await call('POST', '/api/setup', { escritorio: 'X', nome: 'Ana', email: 'ana@x.com', senha: 'curta' })).status, 400);

    const s = await call('POST', '/api/setup', { escritorio: 'Contábil Silva', nome: 'Ana', email: 'Ana@X.com', senha: 'senha-segura-1' });
    assert.equal(s.status, 200);
    assert.equal((await call('GET', '/api/setup/status')).json.configurado, true);
    assert.equal((await call('POST', '/api/setup', { escritorio: 'Invasor', nome: 'Eve', email: 'eve@x.com', senha: 'senha-segura-2' })).status, 409, 'setup não pode ser refeito');
    assert.equal((await call('POST', '/api/login', { email: 'ana@x.com', senha: 'senha-segura-1' })).status, 200);
    const token = s.json.token;

    const emp = { documento: '11.222.333/0001-81', razao_social: 'Padaria', cod_municipio: '4208203', op_simp_nac: 3 };
    assert.equal((await call('POST', '/api/empresas', emp, token)).status, 200);
    assert.equal((await call('POST', '/api/empresas', emp, token)).status, 409, 'CNPJ duplicado');

    // backup: baixado e automático, ambos bancos SQLite válidos que contêm os dados
    const bk = await call('GET', '/api/backup/baixar', undefined, token);
    assert.equal(bk.status, 200);
    assert.equal(bk.raw.subarray(0, 15).toString(), 'SQLite format 3');
    const lista = (await call('GET', '/api/backup', undefined, token)).json;
    assert.equal(lista.automaticos.length, 1);
    const { DatabaseSync } = await import('node:sqlite');
    const copia = new DatabaseSync(path.join(tmp, 'backups', lista.automaticos[0].nome));
    assert.ok(copia.prepare('SELECT COUNT(*) AS n FROM usuarios').get());
    copia.close();
    const baixado = path.join(tmp, 'baixado.db');
    fs.writeFileSync(baixado, bk.raw);
    const c2 = new DatabaseSync(baixado);
    assert.equal((c2.prepare('SELECT COUNT(*) AS n FROM empresas').get() as any).n, 1);
    c2.close();
  } finally { await app.close(); }
});

test('última empresa escolhida é lembrada no banco', async () => {
  const { db } = await import('../src/db.js');
  const col = (db.prepare('PRAGMA table_info(usuarios)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(col.includes('ultima_empresa_id'));
});
