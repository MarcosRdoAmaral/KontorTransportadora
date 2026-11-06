import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-orc-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40), NFSE_DESKTOP: '1' });
process.env.LICENCA_CHAVE_PUBLICA ??= ''; // sem controle de licença neste teste

test('orçamento de serviços: itens, situação, PDF, conversão em nota e faturamento parcial', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE SERVICOS LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const tom = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, email) VALUES (?, 'CPF', '52998224725', 'Cliente A', 'a@x.com')").run(eid).lastInsertRowid);
    const serv = Number(db.prepare("INSERT INTO servicos (empresa_id, nome, descricao, c_trib_nac) VALUES (?, 'Consultoria', 'Consultoria mensal', '171901')").run(eid).lastInsertRowid);
    const base = `/api/empresas/${eid}/orcamentos`;
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const mais = (d: number) => new Date(Date.parse(hoje) + d * 864e5).toISOString().slice(0, 10);
    const corpo = { tomadorId: tom, validade: mais(10), condicoes: '50% na aprovação e o restante na entrega', desconto: 100,
      itens: [{ servicoId: serv, descricao: 'Consultoria', quantidade: 2, valorUnitario: 500 }, { descricao: 'Treinamento da equipe', quantidade: 1, valorUnitario: 600 }] };

    // validações
    assert.equal((await call('POST', base, { ...corpo, itens: [] }, t)).status, 400);
    assert.match((await call('POST', base, { ...corpo, desconto: 5000 }, t)).json.erro, /desconto/);
    assert.equal((await call('POST', base, { ...corpo, tomadorId: undefined }, t)).status, 400, 'sem cliente nem nome');

    // cria: total = 2x500 + 600 - 100
    const o = (await call('POST', base, corpo, t)).json;
    assert.equal(o.numero, 1);
    assert.equal(o.total, 1500);
    assert.equal(o.situacao, 'RASCUNHO');
    assert.equal(o.saldo, 1500);
    assert.equal((await call('POST', base, { ...corpo, tomadorId: undefined, clienteNome: 'Prospecto sem cadastro' }, t)).json.numero, 2);

    // PDF
    const pdf = await call('GET', `${base}/${o.id}/pdf`, undefined, t);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');

    // rascunho ainda não vira nota
    assert.match((await call('GET', `${base}/${o.id}/conversao`, undefined, t)).json.erro, /enviado ou aprovado/);
    assert.equal((await call('POST', `${base}/${o.id}/situacao`, { acao: 'ENVIADO' }, t)).json.situacao, 'ENVIADO');

    // vence sozinho se o prazo passou sem resposta
    db.prepare('UPDATE orcamentos SET validade = ? WHERE id = ?').run(mais(-1), o.id);
    assert.equal((await call('GET', `${base}/${o.id}`, undefined, t)).json.situacao, 'VENCIDO');
    db.prepare('UPDATE orcamentos SET validade = ? WHERE id = ?').run(mais(10), o.id);

    // recusado não converte; reabrir volta ao rascunho
    assert.equal((await call('POST', `${base}/${o.id}/situacao`, { acao: 'RECUSADO', motivo: 'Preço' }, t)).json.situacao, 'RECUSADO');
    assert.match((await call('GET', `${base}/${o.id}/conversao`, undefined, t)).json.erro, /recusado/);
    await call('POST', `${base}/${o.id}/situacao`, { acao: 'REABRIR' }, t);
    await call('POST', `${base}/${o.id}/situacao`, { acao: 'APROVADO' }, t);

    // conversão: nota única = saldo, com os itens na descrição; serviços diferentes => sem serviço fixo
    let c = (await call('GET', `${base}/${o.id}/conversao`, undefined, t)).json;
    assert.equal(c.valor, 1500);
    assert.equal(c.descricao, 'Consultoria; Treinamento da equipe');
    assert.equal(c.servicoId, null);
    assert.equal(c.tomadorId, tom);
    // conversão de um item: o serviço e o valor do item
    const itemA = o.itens[0].id, itemB = o.itens[1].id;
    c = (await call('GET', `${base}/${o.id}/conversao?item=${itemA}`, undefined, t)).json;
    assert.equal(c.valor, 1000);
    assert.equal(c.servicoId, serv);
    assert.match(c.descricao, /Consultoria \(2 x R\$ 500,00\)/);
    // valor acima do saldo é recusado
    assert.match((await call('GET', `${base}/${o.id}/conversao?valor=1600`, undefined, t)).json.erro, /entre R\$ 0,01 e R\$ 1\.500,00/);

    // nota parcial de 50% (a emissão em si usa o certificado; aqui registramos a nota como a rota faz)
    const nota = (valor: number, status: string) => Number(db.prepare(`INSERT INTO notas (empresa_id, tomador_id, ambiente, serie, n_dps, id_dps, status, competencia, valor_servico, descricao, payload_json)
      VALUES (?,?,2,'1',?,?,?,?,?,'x','{}')`).run(eid, tom, Math.floor(Math.random() * 1e9), 'DPS' + crypto.randomBytes(8).toString('hex'), status, hoje, valor).lastInsertRowid);
    const { vincularNota, conferirAntesDeEmitir } = await import('../src/servicos/orcamentos.js');
    conferirAntesDeEmitir(eid, o.id, null, 750);
    const n1 = nota(750, 'AUTORIZADA');
    vincularNota(eid, o.id, null, n1, 750);
    let r = (await call('GET', `${base}/${o.id}`, undefined, t)).json;
    assert.equal(r.situacao, 'PARCIAL');
    assert.equal(r.faturado, 750);
    assert.equal(r.saldo, 750);
    assert.equal(r.notas.length, 1);
    assert.throws(() => conferirAntesDeEmitir(eid, o.id, null, 800), /entre R\$ 0,01 e R\$ 750,00/);
    assert.match((await call('PUT', `${base}/${o.id}`, corpo, t)).json.erro, /já tem notas emitidas/);
    assert.match((await call('DELETE', `${base}/${o.id}`, undefined, t)).json.erro, /não pode ser excluído/);
    assert.match((await call('POST', `${base}/${o.id}/situacao`, { acao: 'RECUSADO' }, t)).json.erro, /já tem notas/);

    // nota recusada pela prefeitura devolve o valor ao saldo
    const n2 = nota(750, 'PENDENTE');
    vincularNota(eid, o.id, null, n2, 750);
    assert.equal((await call('GET', `${base}/${o.id}`, undefined, t)).json.situacao, 'FATURADO');
    db.prepare("UPDATE notas SET status = 'REJEITADA' WHERE id = ?").run(n2);
    r = (await call('GET', `${base}/${o.id}`, undefined, t)).json;
    assert.equal(r.situacao, 'PARCIAL');
    assert.equal(r.saldo, 750);
    // refaz e completa
    const n3 = nota(750, 'AUTORIZADA');
    vincularNota(eid, o.id, null, n3, 750);
    r = (await call('GET', `${base}/${o.id}`, undefined, t)).json;
    assert.equal(r.situacao, 'FATURADO');
    assert.equal(r.saldo, 0);
    assert.match((await call('GET', `${base}/${o.id}/conversao`, undefined, t)).json.erro, /faturado por inteiro/);

    // converter um orçamento recém-enviado o aprova sozinho
    const o3 = (await call('POST', base, corpo, t)).json;
    await call('POST', `${base}/${o3.id}/situacao`, { acao: 'ENVIADO' }, t);
    vincularNota(eid, o3.id, o3.itens[1].id, nota(600, 'AUTORIZADA'), 600);
    r = (await call('GET', `${base}/${o3.id}`, undefined, t)).json;
    assert.equal(r.situacao_base, 'APROVADO');
    assert.equal(r.itens[1].faturado, 600);
    assert.match((await call('GET', `${base}/${o3.id}/conversao?item=${o3.itens[1].id}`, undefined, t)).json.erro, /item já foi faturado/);

    // duplicar e listar
    const d = (await call('POST', `${base}/${o.id}/duplicar`, undefined, t)).json;
    assert.equal(d.situacao, 'RASCUNHO');
    assert.equal(d.itens.length, 2);
    assert.equal((await call('GET', base, undefined, t)).json.length, 4);

    // outra empresa não enxerga o orçamento
    const e2 = (await call('POST', '/api/empresas', { documento: '45.723.174/0001-10', razao_social: 'OUTRA LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    assert.equal((await call('GET', `/api/empresas/${e2}/orcamentos/${o.id}`, undefined, t)).status, 404);
  } finally { await app.close(); }
});
