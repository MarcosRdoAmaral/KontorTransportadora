import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.LICENCA_CHAVE_PUBLICA ??= ''; // sem controle de licença neste teste
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-ag-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });

test('agenda: data prevista no dia útil e último dia do mês', async () => {
  const { dataPrevista } = await import('../src/servicos/agenda.js');
  assert.equal(dataPrevista('2026-11', 14), '2026-11-14'.replace('14', '16'), '14/11/2026 é sábado e 15 é feriado/domingo → segunda 16');
  assert.equal(dataPrevista('2026-02', 31), '2026-03-02', '28/02 é sábado → segunda 02/03');
  assert.equal(dataPrevista('2026-10', 5), '2026-10-05');
});

test('emissão automática: pronta no dia, confirma, não repete, pular e erro', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '11.222.333/0001-81', razao_social: 'Empresa Portal', cod_municipio: '4208203', op_simp_nac: 3, modo_emissao: 'PORTAL', portal_login: '11222333000181' }, t)).json.id;
    const sv = (await call('POST', `/api/empresas/${eid}/servicos`, { nome: 'Honorários', descricao: 'Honorários contábeis', c_trib_nac: '171901' }, t)).json.id;
    const tom = (await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CPF', documento: '39053344705', nome: 'Cliente Mensal', modo_faturamento: 'BOLETO', servicos_padrao: [{ servico_id: sv, valor: 800 }] }, t)).json.id;
    // mês anterior: o dia 1 dele (ajustado a dia útil) já passou, em qualquer data em que o teste rodar
    const mes = (() => { const d = new Date(Date.now() - 3 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();

    assert.equal((await call('POST', `/api/empresas/${eid}/agenda/config`, { tomadorId: tom, ativa: true, dia: 40 }, t)).status, 400);
    assert.equal((await call('POST', `/api/empresas/${eid}/agenda/config`, { tomadorId: tom, ativa: true, dia: 1 }, t)).status, 200);
    let ag = (await call('GET', `/api/empresas/${eid}/agenda?mes=${mes}`, undefined, t)).json;
    assert.equal(ag.itens.length, 1); assert.equal(ag.itens[0].status, 'PRONTA'); assert.equal(ag.resumo.prontas, 1);
    const futuro = (await call('GET', `/api/empresas/${eid}/agenda?mes=2099-01`, undefined, t)).json;
    assert.equal(futuro.itens[0].status, 'AGENDADA');

    const r = (await call('POST', `/api/empresas/${eid}/agenda/executar`, { tomadorId: tom, servicoId: sv, mes }, t)).json;
    assert.equal(r.status, 'EMITIDA'); assert.equal(r.cobranca.valor, 800);
    ag = (await call('GET', `/api/empresas/${eid}/agenda?mes=${mes}`, undefined, t)).json;
    assert.equal(ag.itens[0].status, 'EMITIDA'); assert.ok(ag.itens[0].cobranca_id);
    assert.equal((await call('POST', `/api/empresas/${eid}/agenda/executar`, { tomadorId: tom, servicoId: sv, mes }, t)).status, 400, 'não emite duas vezes no mês');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cobrancas WHERE tomador_id = ?').get(tom) as any).n, 1);

    // outro cliente: pular e desfazer
    const tom2 = (await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CPF', documento: '52998224725', nome: 'Cliente B', modo_faturamento: 'BOLETO', servicos_padrao: [{ servico_id: sv, valor: 300 }] }, t)).json.id;
    await call('POST', `/api/empresas/${eid}/agenda/config`, { tomadorId: tom2, ativa: true, dia: 1 }, t);
    await call('POST', `/api/empresas/${eid}/agenda/pular`, { tomadorId: tom2, servicoId: sv, mes }, t);
    assert.equal((await call('GET', `/api/empresas/${eid}/agenda?mes=${mes}`, undefined, t)).json.itens.find((i: any) => i.tomador_id === tom2).status, 'PULADA');
    await call('POST', `/api/empresas/${eid}/agenda/pular`, { tomadorId: tom2, servicoId: sv, mes, desfazer: true }, t);
    const todas = (await call('POST', `/api/empresas/${eid}/agenda/executar-todas`, { mes }, t)).json;
    assert.deepEqual([todas.total, todas.emitidas, todas.erros], [1, 1, 0]);

    // cliente só de nota em empresa do portal: erro explicado, sem emitir
    const tom3 = (await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CPF', documento: '11144477735', nome: 'Cliente Nota', modo_faturamento: 'NOTA', servicos_padrao: [{ servico_id: sv, valor: 100 }] }, t)).json.id;
    await call('POST', `/api/empresas/${eid}/agenda/config`, { tomadorId: tom3, ativa: true, dia: 1 }, t);
    const e3 = (await call('POST', `/api/empresas/${eid}/agenda/executar`, { tomadorId: tom3, servicoId: sv, mes }, t)).json;
    assert.equal(e3.status, 'ERRO'); assert.match(e3.mensagem, /portal/);
  } finally { await app.close(); }
});
