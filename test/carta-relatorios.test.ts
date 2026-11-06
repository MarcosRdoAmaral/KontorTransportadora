import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('relatórios novos (carteira, cidade/UF, cadastro incompleto), PDF timbrado e carta de cobrança', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-carta-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { dadosCartaCobranca } = await import('../src/servicos/carta-cobranca.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, corpo: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'CICLO ASSESSORIA CONTABIL LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const tid = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, cidade, uf, cod_municipio) VALUES (?, 'CNPJ', '36128844000160', 'ABM TRANSPORTES', 'Blumenau', 'SC', '4202404')").run(eid).lastInsertRowid);
    const cob = (venc: string, forma: string, status: string) => Number(db.prepare("INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status, forma, multa_pct, juros_pct_mes) VALUES (?, ?, 'Mensalidade', 100, ?, ?, ?, 2, 1)").run(eid, tid, venc, status, forma).lastInsertRowid);
    const c1 = cob('2020-01-10', 'BOLETO', 'REGISTRADO'); cob('2020-02-10', 'PIX', 'AGUARDANDO_BANCO'); cob('2099-01-10', 'PIX', 'REGISTRADO');
    const rel = async (id: string, extra = '') => call('GET', `/api/empresas/${eid}/relatorios/${id}?de=2019-01-01&ate=2099-12-31${extra}`, undefined, t);
    const rc = (await rel('a-receber-carteira')).json;
    assert.deepEqual(rc.linhas.filter((l: any) => l._subtotal).map((l: any) => l.valor_sub), [100, 200]);
    assert.equal(rc.totais.valor, 300, 'subtotais não entram no total');
    assert.match((await rel('cadastro-incompleto')).json.linhas[0].falta, /e-mail, telefone, endereço/);
    assert.equal((await rel('faturamento-cidade')).json.linhas.length, 0);
    const pdf = await rel('a-receber-carteira', '&formato=pdf');
    assert.equal(pdf.status, 200); assert.equal(pdf.corpo.subarray(0, 4).toString(), '%PDF');
    const carta = dadosCartaCobranca(eid, tid, '2020-03-10');
    assert.equal(carta.titulos.length, 2);
    assert.deepEqual([carta.titulos[0].multa, carta.titulos[0].juros, carta.titulos[0].atualizado], [2, 2, 104]);
    const pc = await call('GET', `/api/cobrancas/${c1}/carta`, undefined, t);
    assert.equal(pc.status, 200); assert.equal(pc.corpo.subarray(0, 4).toString(), '%PDF');
  } finally { await app.close(); }
});
