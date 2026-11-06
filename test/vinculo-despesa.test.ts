import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('saída do extrato ligada à parcela de uma compra: sem duplicar a despesa', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-vinc-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DEV: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { sincronizarDespesasDoExtrato } = await import('../src/servicos/extrato.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const token = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const emp = (await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, token)).json.id;
    const desp = Number(db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, origem) VALUES (?, '2026-08-10', 'Material', 'NF 123 — Papelaria (parcela 1/2)', 150, 'MANUAL')").run(emp).lastInsertRowid);
    const imp = Number(db.prepare("INSERT INTO extrato_importacoes (empresa_id, arquivo, qtd, hash) VALUES (?, 'x.pdf', 1, 'h1')").run(emp).lastInsertRowid);
    const lid = Number(db.prepare("INSERT INTO extrato_lancamentos (empresa_id, importacao_id, data, descricao, documento, valor, saldo, categoria, chave) VALUES (?,?, '2026-08-12', 'PIX ENVIADO PAPELARIA', '1', -150, 0, 'Material', 'k1')").run(emp, imp).lastInsertRowid);
    sincronizarDespesasDoExtrato(emp);
    // sem vínculo: a saída gera o espelho e a despesa manual fica em duplicidade
    assert.equal((db.prepare('SELECT COUNT(*) n FROM despesas WHERE empresa_id = ?').get(emp) as any).n, 2);

    const url = `/api/empresas/${emp}/extrato/${lid}`;
    const cand = (await call('GET', `${url}/despesas`, undefined, token)).json;
    assert.deepEqual(cand.map((c: any) => c.id), [desp]);
    // valor diferente é recusado
    const outra = Number(db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, origem) VALUES (?, '2026-08-11', 'Material', 'outra', 99, 'MANUAL')").run(emp).lastInsertRowid);
    assert.equal((await call('POST', `${url}/despesa`, { despesaId: outra }, token)).status, 400);

    assert.equal((await call('POST', `${url}/despesa`, { despesaId: desp }, token)).status, 200);
    const lista = db.prepare('SELECT id, origem FROM despesas WHERE empresa_id = ? AND valor = 150').all(emp) as any[];
    assert.deepEqual(lista.map((x) => x.id), [desp]);
    const mes = (await call('GET', `/api/empresas/${emp}/extrato?mes=2026-08`, undefined, token)).json;
    assert.equal(mes.lancamentos[0].despesa_ligada_id, desp);
    assert.deepEqual((await call('GET', `${url}/despesas`, undefined, token)).json, []);

    // desfazer devolve o espelho do extrato
    assert.equal((await call('POST', `${url}/despesa`, { despesaId: null }, token)).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM despesas WHERE empresa_id = ? AND valor = 150 AND origem = 'EXTRATO'").get(emp) as any).n, 1);
    // entrada não liga
    const ent = Number(db.prepare("INSERT INTO extrato_lancamentos (empresa_id, importacao_id, data, descricao, documento, valor, saldo, chave) VALUES (?,?, '2026-08-13', 'CRED', '2', 150, 0, 'k2')").run(emp, imp).lastInsertRowid);
    assert.equal((await call('POST', `/api/empresas/${emp}/extrato/${ent}/despesa`, { despesaId: desp }, token)).status, 400);
  } finally { await app.close(); }
});
