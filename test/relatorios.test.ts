import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-rel-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });

test('relatórios: nota emitida em uma data e boleto com vencimento em outra', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, token?: string) => {
    const r = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.body, raw: r.rawPayload, tipo: String(r.headers['content-type']) };
  };
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' } });
    const t = setup.json().token;
    const emp = await app.inject({ method: 'POST', url: '/api/empresas', headers: { authorization: `Bearer ${t}` }, payload: { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 } });
    const eid = emp.json().id;
    const tom = (n: string, d: string) => Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, modo_faturamento) VALUES (?,?,?,?,'NOTA_BOLETO')").run(eid, 'CPF', d, n).lastInsertRowid);
    const [a, b] = [tom('Cliente A', '52998224725'), tom('Cliente B', '11144477735')];
    const nota = (tid: number, n: string, valor: number, emi: string) => Number(db.prepare(`INSERT INTO notas (empresa_id, tomador_id, ambiente, serie, n_dps, id_dps, status, competencia, valor_servico, descricao, tomador_nome, payload_json, n_nfse, autorizada_em, xml_nfse)
      VALUES (?,?,2,'1',?,?,'AUTORIZADA',?,?,'Honorários','x','{}',?,?,NULL)`).run(eid, tid, Number(n), 'DPS' + n, emi.slice(0, 10), valor, n, emi + ' 15:00:00').lastInsertRowid);
    const cob = (tid: number, nid: number | null, valor: number, venc: string, status: string, pago: string | null, criado: string) =>
      db.prepare('INSERT INTO cobrancas (empresa_id, tomador_id, nota_id, descricao, valor, vencimento, status, pago_em, valor_pago, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)').run(eid, tid, nid, 'x', valor, venc, status, pago, pago ? valor : null, criado + ' 10:00:00');
    // nota emitida em setembro, boleto vence em outubro; outra emitida em outubro, vence em novembro
    const n1 = nota(a, '10', 1000, '2026-09-20'); cob(a, n1, 1000, '2026-10-10', 'PAGO', '2026-10-09', '2026-09-20');
    const n2 = nota(b, '11', 500, '2026-10-05'); cob(b, n2, 500, '2026-10-15', 'REGISTRADO', null, '2026-10-05');
    const n3 = nota(a, '12', 300, '2026-10-06'); cob(a, n3, 300, '2026-11-20', 'REGISTRADO', null, '2026-10-06');
    nota(b, '13', 200, '2026-10-07'); // sem boleto
    const rel = async (id: string, qs: string) => (await call('GET', `/api/empresas/${eid}/relatorios/${id}?${qs}`, t));

    // receitas emitidas em outubro: pega as notas de outubro mesmo com vencimento em novembro; a nota de setembro fica de fora
    const r1 = (await rel('receitas-emitidas', 'de=2026-10-01&ate=2026-10-31')).json;
    assert.deepEqual(r1.linhas.map((l: any) => l.n_nfse), ['11', '12', '13']);
    assert.equal(r1.linhas.find((l: any) => l.n_nfse === '12').vencimento, '2026-11-20');
    assert.equal(r1.linhas.find((l: any) => l.n_nfse === '13').situacao, 'Sem boleto');
    assert.equal(r1.totais.valor_servico, 1000);

    // a receber por vencimento em outubro: só a nota 11 (a 12 vence em novembro; a 10 já foi paga)
    const r2 = (await rel('a-receber', 'de=2026-10-01&ate=2026-10-31')).json;
    assert.deepEqual(r2.linhas.map((l: any) => l.n_nfse), ['11']); assert.equal(r2.linhas[0].emissao, '2026-10-05'); assert.equal(r2.linhas[0].situacao, 'Vencido');

    // em aberto por emissão em outubro: 11 e 12, vencimentos diferentes
    const r3 = (await rel('em-aberto-emissao', 'de=2026-10-01&ate=2026-10-31')).json;
    assert.deepEqual(r3.linhas.map((l: any) => [l.n_nfse, l.vencimento]), [['11', '2026-10-15'], ['12', '2026-11-20']]);
    assert.equal((await rel('em-aberto-emissao', 'de=2026-10-01&ate=2026-10-31&situacao=Vencido')).json.linhas.length, 1);

    // recebimentos por data de pagamento: nota emitida em setembro, paga em outubro, 1 dia antes do vencimento
    const r4 = (await rel('recebimentos', 'de=2026-10-01&ate=2026-10-31')).json;
    assert.equal(r4.linhas.length, 1); assert.equal(r4.linhas[0].atraso, 0); assert.equal(r4.totais.valor_pago, 1000);

    // saldo vencido por cliente em 31/10: B deve 500 (16 dias)
    const r5 = (await rel('saldo-vencido', 'de=2026-10-01&ate=2026-10-31')).json;
    assert.deepEqual(r5.linhas.map((l: any) => [l.cliente, l.f1, l.total]), [['Cliente B', 500, 500]]);

    const r6 = (await rel('posicao-clientes', 'de=2026-09-01&ate=2026-10-31')).json;
    assert.equal(r6.totais.faturado, 1800); assert.equal(r6.totais.recebido, 1000);
    assert.equal((await rel('notas-emitidas', 'de=2026-09-01&ate=2026-10-31')).status, 200);
    assert.equal((await rel('fluxo-caixa', 'de=2026-09-01&ate=2026-10-31')).status, 200);

    // formatos, validações e permissão
    const csv = await rel('receitas-emitidas', 'de=2026-10-01&ate=2026-10-31&formato=csv');
    assert.match(csv.tipo, /csv/); assert.match(csv.body, /Vencimento/); assert.match(csv.body, /TOTAL/);
    const pdf = await rel('receitas-emitidas', 'de=2026-10-01&ate=2026-10-31&formato=pdf');
    assert.equal(Buffer.from(pdf.raw).subarray(0, 4).toString(), '%PDF');
    assert.equal((await rel('inexistente', 'de=2026-10-01&ate=2026-10-31')).status, 404);
    assert.equal((await rel('a-receber', 'de=2026-10-31&ate=2026-10-01')).status, 400);
    assert.equal((await call('GET', `/api/empresas/${eid}/relatorios/a-receber?de=2026-10-01&ate=2026-10-31`)).status, 401);
    const cat = (await call('GET', '/api/relatorios', t)).json;
    assert.equal(cat.length, 24);
    assert.ok(cat.every((c: any) => c.grupo), 'todo relatório tem grupo');
    assert.deepEqual([...new Set(cat.map((c: any) => c.grupo))].sort(), ['Clientes', 'Contas a receber', 'Despesas e pagamentos', 'Faturamento', 'Fiscal e retenções', 'Resultado e caixa']);
    // todos os relatórios rodam, em JSON e PDF, sem erro
    for (const c of cat) {
      const r = await rel(c.id, 'de=2026-10-01&ate=2026-10-31');
      assert.equal(r.status, 200, `${c.id}: ${JSON.stringify(r.json)}`);
      assert.equal(Buffer.from((await rel(c.id, 'de=2026-10-01&ate=2026-10-31&formato=pdf')).raw).subarray(0, 4).toString(), '%PDF', c.id);
    }
    // faturamento por mês e curva ABC conferem com as notas (set: 1000 · out: 500 + 300 + 200)
    const fm = (await rel('faturamento-mensal', 'de=2026-09-01&ate=2026-10-31')).json;
    assert.deepEqual(fm.linhas.map((l: any) => [l.mes, l.faturado]), [['09/2026', 1000], ['10/2026', 1000]]);
    const abc = (await rel('curva-abc', 'de=2026-09-01&ate=2026-10-31')).json;
    assert.equal(abc.totais.valor, 2000); assert.equal(abc.linhas[0].classe, 'A');
    // despesas por categoria/forma
    db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, forma_pagamento) VALUES (?,?,?,?,?,?)").run(eid, '2026-10-05', 'Material', 'Papel', 40, 'PIX');
    db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, forma_pagamento) VALUES (?,?,?,?,?,?)").run(eid, '2026-10-06', 'Material', 'Caneta', 10, null);
    const dc = (await rel('despesas-categoria', 'de=2026-10-01&ate=2026-10-31')).json; assert.deepEqual(dc.linhas.map((l: any) => [l.categoria, l.valor, l.pct]), [['Material', 50, 100]]);
    const df = (await rel('despesas-forma', 'de=2026-10-01&ate=2026-10-31')).json; assert.deepEqual(df.linhas.map((l: any) => [l.forma, l.valor]), [['PIX', 40], ['Não informado', 10]]);
  } finally { await app.close(); }
});
