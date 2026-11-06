import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ajustarVencimento, feriados, motivoNaoUtil } from '../src/servicos/diautil.js';

test('dia útil: fins de semana, feriados móveis e locais', () => {
  assert.deepEqual([...feriados(2026)].filter((d) => /-(02-16|02-17|04-03|06-04)$/.test(d)).sort(), ['2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04']); // carnaval, sexta santa, corpus christi
  assert.equal(motivoNaoUtil('2026-10-24'), 'sábado'); assert.equal(motivoNaoUtil('2026-10-25'), 'domingo');
  assert.equal(motivoNaoUtil('2026-10-12'), 'feriado'); assert.equal(motivoNaoUtil('2026-10-26'), '');
  assert.equal(motivoNaoUtil('2026-06-24'), ''); assert.equal(motivoNaoUtil('2026-06-24', '24/06'), 'feriado');
  assert.equal(ajustarVencimento('2026-11-10', '2026-10-24').aviso, undefined);
  const a = ajustarVencimento('2026-11-15', '2026-10-24'); // domingo + feriado 15/11: volta para sexta 13/11
  assert.equal(a.data, '2026-11-13'); assert.match(a.aviso!, /antecipado/);
  const b = ajustarVencimento('2026-10-24', '2026-10-24'); // sábado hoje: sexta já passou, vai para segunda
  assert.equal(b.data, '2026-10-26'); assert.match(b.aviso!, /adiado/);
});

test('painel financeiro, despesas e balanço', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-fin-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, t)).json.id;
    const tom = (n: string, d: string) => Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, modo_faturamento) VALUES (?,?,?,?,'NOTA_BOLETO')").run(eid, 'CPF', d, n).lastInsertRowid);
    const [c1, c2, c3] = [tom('Cliente A', '52998224725'), tom('Cliente B', '11144477735'), tom('Cliente C', '39053344705')];
    const cob = (tid: number, valor: number, venc: string, status: string, pago: string | null, criado: string) =>
      db.prepare('INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status, pago_em, valor_pago, criado_em) VALUES (?,?,?,?,?,?,?,?,?)').run(eid, tid, 'x', valor, venc, status, pago, pago ? valor : null, criado);
    cob(c1, 1000, '2026-10-10', 'PAGO', '2026-10-09', '2026-10-01 10:00:00');
    cob(c2, 500, '2026-10-05', 'REGISTRADO', null, '2026-10-01 10:00:00');   // atrasada (hoje 2026-10-24)
    cob(c2, 300, '2026-10-30', 'REGISTRADO', null, '2026-10-02 10:00:00');   // a vencer
    cob(c1, 800, '2026-09-10', 'PAGO', '2026-09-12', '2026-09-01 10:00:00');
    cob(c1, 99, '2026-10-20', 'CANCELADO', null, '2026-10-01 10:00:00');       // não conta

    assert.equal((await call('POST', `/api/empresas/${eid}/despesas`, { data: '2026-10-03', categoria: 'Aluguel', valor: 700 }, t)).status, 200);
    assert.equal((await call('POST', `/api/empresas/${eid}/despesas`, { data: '2026-09-03', categoria: 'Aluguel', valor: 400, descricao: 'set' }, t)).status, 200);
    assert.equal((await call('POST', `/api/empresas/${eid}/despesas`, { data: '2026-10-03', categoria: 'Aluguel', valor: 0 }, t)).status, 400);

    const { painelFinanceiro } = await import('../src/servicos/financeiro.js');
    const p = painelFinanceiro(eid, '2026-10', '2026-10-24');
    assert.deepEqual([p.kpis.faturado, p.kpis.recebido, p.kpis.aReceber, p.kpis.emAtraso, p.kpis.qtd, p.kpis.inadimplencia], [1800, 1000, 300, 500, 3, 33]);
    assert.equal(p.atrasadas[0].dias, 19); assert.equal(p.atrasadas[0].tomador, 'Cliente B');
    assert.deepEqual(p.serie.at(-1), { mes: '2026-10', recebido: 1000, aberto: 800 });
    assert.deepEqual(p.balanco.at(-1), { mes: '2026-10', receitas: 1000, despesas: 700, resultado: 300 });
    assert.deepEqual(p.balanco.at(-2), { mes: '2026-09', receitas: 800, despesas: 400, resultado: 400 });
    assert.equal(p.faltamEmitir.qtd, 1); assert.equal(p.faltamEmitir.clientes[0].nome, 'Cliente C');
    assert.ok(p.dicas.some((d) => /em atraso/.test(d)) && p.dicas.length <= 5);

    const lista = (await call('GET', `/api/empresas/${eid}/despesas?mes=2026-10`, undefined, t)).json;
    assert.equal(lista.despesas.length, 1); assert.ok(lista.categorias.includes('Aluguel'));
    const id = lista.despesas[0].id;
    assert.equal((await call('PUT', `/api/empresas/${eid}/despesas/${id}`, { data: '2026-10-04', categoria: 'Aluguel', valor: 750 }, t)).status, 200);
    assert.equal((await call('DELETE', `/api/empresas/${eid}/despesas/${id}`, undefined, t)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${eid}/despesas?mes=2026-10`, undefined, t)).json.despesas.length, 0);
    assert.equal((await call('PUT', `/api/empresas/${eid}/feriados`, { feriados_extra: '24/06, 19/03' }, t)).status, 200);
    assert.equal((await call('PUT', `/api/empresas/${eid}/feriados`, { feriados_extra: 'amanhã' }, t)).status, 400);

    // reemitir: copia cliente/descrição, vencimento ajustado para dia útil
    const origem = (db.prepare("SELECT id FROM cobrancas WHERE status = 'PAGO' ORDER BY id LIMIT 1").get() as any).id;
    const re = await call('POST', `/api/cobrancas/${origem}/reemitir`, { vencimento: '2027-01-31', valor: 1234.5 }, t); // domingo
    assert.equal(re.status, 200, JSON.stringify(re.json));
    assert.equal(re.json.cobranca.vencimento, '2027-01-29'); assert.equal(re.json.cobranca.valor, 1234.5); assert.equal(re.json.cobranca.tomador_id, c1);
    assert.match(re.json.aviso, /antecipado/); assert.equal(re.json.cobranca.nota_id, null);
    assert.equal((await call('POST', `/api/cobrancas/${origem}/reemitir`, { vencimento: 'x' }, t)).status, 400);

    // boleto avulso (sem nota), a partir da tela de Cobranças
    const av = await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: c3, descricao: 'Honorários', valor: 450, vencimento: '2027-02-14' }, t); // domingo
    assert.equal(av.status, 200, JSON.stringify(av.json));
    assert.equal(av.json.acao, 'BOLETO'); assert.equal(av.json.nota, undefined); assert.equal(av.json.cobranca.valor, 450);
    assert.equal(av.json.cobranca.vencimento, '2027-02-12'); assert.equal(av.json.cobranca.nota_id, null);
    assert.equal((await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: c3, descricao: 'x', valor: -1 }, t)).status, 400);
    assert.equal((await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: 999999, descricao: 'Honorários', valor: 10 }, t)).status, 400);

    // desconto fixo do cliente: motivo obrigatório, abatido em todo boleto e registrado na cobrança
    const tdesc = await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CPF', documento: '11144477735', nome: 'Cliente Desconto', modo_faturamento: 'BOLETO', desconto_valor: 50 }, t);
    assert.equal(tdesc.status, 400, 'desconto sem motivo');
    const tok = await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CPF', documento: '39053344705', nome: 'Cliente Desconto', modo_faturamento: 'BOLETO', desconto_valor: 50, desconto_motivo: 'Fidelidade' }, t);
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
    const d1 = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tok.json.id, descricao: 'Honorários', valor: 500, vencimento: '2027-03-10' }, t)).json.cobranca;
    assert.equal(d1.valor, 450); assert.equal(d1.desconto, 50); assert.equal(d1.desconto_motivo, 'Fidelidade');
    const d2 = (await call('POST', `/api/cobrancas/${d1.id}/reemitir`, { vencimento: '2027-04-09' }, t)).json.cobranca;
    assert.equal(d2.valor, 450, 'reemitir parte do valor antes do desconto e abate de novo');
    assert.equal((await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tok.json.id, descricao: 'Honorários', valor: 50, vencimento: '2027-03-10' }, t)).status, 400, 'desconto >= valor');
    assert.equal((await call('PUT', `/api/tomadores/${tok.json.id}`, { tipo_doc: 'CPF', documento: '39053344705', nome: 'Cliente Desconto', modo_faturamento: 'BOLETO' }, t)).status, 200);
    assert.equal((await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tok.json.id, descricao: 'Honorários', valor: 500, vencimento: '2027-03-10' }, t)).json.cobranca.valor, 500, 'sem desconto cadastrado');

    // serviços padrão do cliente (serviço + valor), base para emissão recorrente
    const sv1 = (await call('POST', `/api/empresas/${eid}/servicos`, { nome: 'Honorários', descricao: 'Honorários contábeis', c_trib_nac: '171901' }, t)).json.id;
    const sv2 = (await call('POST', `/api/empresas/${eid}/servicos`, { nome: 'Folha', descricao: 'Folha de pagamento', c_trib_nac: '171901' }, t)).json.id;
    // exportação para a contabilidade (ZIP com OFX)
    const { unzipSync, strFromU8 } = await import('fflate');
    db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor) VALUES (?,?,?,?,?)").run(eid, '2026-10-12', 'Aluguel', 'Sala', 750.5);
    const rz = await app.inject({ method: 'GET', url: `/api/contabilidade/exportar?empresaId=${eid}&de=2026-10-01&ate=2026-10-31&xml=0&pdf=0&ofx=1`, headers: { authorization: `Bearer ${t}` } });
    assert.equal(rz.statusCode, 200);
    const arqs = unzipSync(new Uint8Array(rz.rawPayload));
    const ofx = strFromU8(arqs['extrato/movimentacao_2026-10-01_2026-10-31.ofx']);
    assert.match(ofx, /<TRNTYPE>DEBIT[\s\S]*<TRNAMT>-750.50/); assert.match(ofx, /<TRNTYPE>CREDIT[\s\S]*<TRNAMT>1000.00/); assert.match(ofx, /<BANKID>085/);
    assert.equal((await call('GET', `/api/contabilidade/exportar?empresaId=${eid}&de=2026-10-01&ate=2026-10-31&xml=0&pdf=0&ofx=0&entradas=0&sefaz=0`, undefined, t)).status, 400);

    // tributação padrão do serviço
    const tri = { tribISSQN: 1, issRetido: 2, pPis: 0.65, pCofins: 3, pCsll: 1, pIrrf: 1.5, pCp: 11, pTotTrib: { fed: 11.33, mun: 3 }, municipioPrestacao: '4208203', infoComplementar: 'Ref. competência' };
    assert.equal((await call('POST', `/api/empresas/${eid}/servicos`, { nome: 'Ruim', descricao: 'x', c_trib_nac: '171901', tributacao: { municipioPrestacao: '123' } }, t)).status, 400);
    const svT = (await call('POST', `/api/empresas/${eid}/servicos`, { nome: 'Tributado', descricao: 'Serviço tributado', c_trib_nac: '171901', tributacao: tri }, t)).json.id;
    const lidoT = (await call("GET", `/api/empresas/${eid}/servicos`, undefined, t)).json.find((x: any) => x.id === svT);
    assert.equal(lidoT.tributacao.issRetido, 2); assert.equal(lidoT.tributacao.pIrrf, 1.5); assert.equal(lidoT.tributacao.pTotTrib.fed, 11.33);
    assert.equal((await call('PUT', `/api/servicos/${svT}`, { nome: 'Tributado', descricao: 'Serviço tributado', c_trib_nac: '171901', tributacao: { ...tri, issRetido: 1 } }, t)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${eid}/servicos`, undefined, t)).json.find((x: any) => x.id === svT).tributacao.issRetido, 1);
    const { comRetencoesDoServico } = await import('../src/servicos/emissao.js');
    const ent: any = { empresaId: eid, servicoId: svT, competencia: '2026-10-01', descricao: 'x', valor: 1000, tribISSQN: 1, issRetido: 1 };
    const aplicada = comRetencoesDoServico(ent);
    assert.deepEqual([aplicada.retencoes?.pis, aplicada.retencoes?.cofins, aplicada.retencoes?.csll, aplicada.retencoes?.irrf, aplicada.retencoes?.cp], [6.5, 30, 10, 15, 110]);
    assert.equal(comRetencoesDoServico({ ...ent, retencoes: { pis: 1 } }).retencoes?.pis, 1, 'retenção informada na nota prevalece');
    const base = { tipo_doc: 'CPF', documento: '39053344705', nome: 'Cliente Padrão', modo_faturamento: 'NOTA_BOLETO' };
    assert.equal((await call('POST', `/api/empresas/${eid}/tomadores`, { ...base, servicos_padrao: [{ servico_id: sv1, valor: 0 }] }, t)).status, 400, 'valor obrigatório');
    assert.equal((await call('POST', `/api/empresas/${eid}/tomadores`, { ...base, servicos_padrao: [{ servico_id: 999999, valor: 10 }] }, t)).status, 400, 'serviço de outra empresa');
    assert.equal((await call('POST', `/api/empresas/${eid}/tomadores`, { ...base, servicos_padrao: [{ servico_id: sv1, valor: 10 }, { servico_id: sv1, valor: 20 }] }, t)).status, 400, 'repetido');
    const tp = await call('POST', `/api/empresas/${eid}/tomadores`, { ...base, servicos_padrao: [{ servico_id: sv1, valor: 800 }, { servico_id: sv2, valor: 150.5, descricao: 'Folha de {mes}', padrao: true }] }, t);
    assert.equal(tp.status, 200, JSON.stringify(tp.json));
    const lido = (await call('GET', `/api/empresas/${eid}/tomadores`, undefined, t)).json.find((x: any) => x.id === tp.json.id);
    assert.deepEqual(lido.servicos_padrao.map((x: any) => [x.servico_id, x.valor, x.padrao]), [[sv2, 150.5, true], [sv1, 800, false]]);
    assert.equal((await call('PUT', `/api/tomadores/${tp.json.id}`, { ...base, servicos_padrao: [{ servico_id: sv1, valor: 900 }] }, t)).status, 200);
    const lido2 = (await call('GET', `/api/empresas/${eid}/tomadores`, undefined, t)).json.find((x: any) => x.id === tp.json.id);
    assert.deepEqual(lido2.servicos_padrao.map((x: any) => [x.servico_id, x.valor, x.padrao]), [[sv1, 900, true]], 'sem principal marcado, o primeiro vira principal');

    // modelos de WhatsApp: padrão até o usuário salvar o seu
    const m0 = (await call('GET', `/api/empresas/${eid}/modelos-whatsapp`, undefined, t)).json;
    assert.match(m0.lembrete, /\{cliente\}/); assert.equal(m0.lembrete, m0.padrao.lembrete);
    assert.equal((await call('PUT', `/api/empresas/${eid}/modelos-whatsapp`, { lembrete: 'Oi {cliente}', atraso: '' }, t)).status, 200);
    const m1 = (await call('GET', `/api/empresas/${eid}/modelos-whatsapp`, undefined, t)).json;
    assert.equal(m1.lembrete, 'Oi {cliente}'); assert.equal(m1.atraso, m0.padrao.atraso);
    assert.ok((await call('GET', `/api/empresas/${eid}/cobrancas`, undefined, t)).json.every((x: any) => 'tomador_fone' in x));

    // usuário normal sem o módulo não acessa despesas
    await call('POST', '/api/usuarios', { login: 'bia', nome: 'Bia', tipo: 'normal', senha: 'bia-senha-123', permissoes: ['painel'], empresas: [] }, t);
    const tb = (await call('POST', '/api/login', { usuario: 'BIA', senha: 'bia-senha-123' })).json.token;
    assert.equal((await call('GET', `/api/empresas/${eid}/painel`, undefined, tb)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${eid}/despesas`, undefined, tb)).status, 403);
  } finally { await app.close(); }
});
