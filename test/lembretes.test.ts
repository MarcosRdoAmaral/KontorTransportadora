import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('lembretes do sininho: cobranças vencidas, notas com erro e certificado', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lemb-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, json: r.json() }; };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    assert.deepEqual((await call('GET', '/api/inicio', undefined, t)).json, { lembretes: [] });
    const eid = (await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, t)).json.id;
    const tid = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome) VALUES (?, 'CPF', '52998224725', 'Cliente A')").run(eid).lastInsertRowid);
    db.prepare("INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status) VALUES (?,?,?,?,?,?)").run(eid, tid, 'x', 100, '2020-01-10', 'REGISTRADO');
    db.prepare("UPDATE empresas SET cert_validade = '2020-01-01' WHERE id = ?").run(eid);
    const l = (await call('GET', '/api/inicio', undefined, t)).json.lembretes;
    assert.equal(l[0].nivel, 'ATENCAO'); assert.match(l[0].texto, /1 cobrança vencida/); assert.equal(l[0].link, '#/cobrancas');
    assert.ok(l.some((x: any) => /certificado digital vencido/.test(x.texto)));
  } finally { await app.close(); }
});
