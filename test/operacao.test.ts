import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-operacao-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40), NFSE_DESKTOP: '1' });
process.env.LICENCA_CHAVE_PUBLICA ??= '';

/** Chave com dígito verificador correto: UF 42, 2610, CNPJ do emitente, modelo 55, série 1, número n. */
function chave(cnpj: string, n: number) {
  const base = `422610${cnpj}55001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}`;
  let soma = 0, peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return base + (r < 2 ? 0 : 11 - r);
}

const EMIT = '45723174000110';
const nfe = (n: number, { modFrete = '0', peso = '1200.500', valor = '15000.00' } = {}) => {
  const ch = chave(EMIT, n);
  return { ch, xml: `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">
<ide><cUF>42</cUF><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${EMIT}</CNPJ><xNome>Industria Alfa SA</xNome><enderEmit><xLgr>Rua A</xLgr><cMun>4209102</cMun><xMun>Joinville</xMun><UF>SC</UF></enderEmit></emit>
<dest><CNPJ>10512356000168</CNPJ><xNome>Comercio Beta</xNome><enderDest><xLgr>Rua B</xLgr><cMun>4106902</cMun><xMun>Curitiba</xMun><UF>PR</UF></enderDest></dest>
<det nItem="1"><prod><cProd>1</cProd><xProd>Pecas automotivas</xProd><NCM>87089990</NCM><CFOP>6102</CFOP><uCom>UN</uCom><qCom>10</qCom><vUnCom>1500</vUnCom><vProd>${valor}</vProd></prod></det>
<total><ICMSTot><vProd>${valor}</vProd><vNF>${valor}</vNF></ICMSTot></total>
<transp><modFrete>${modFrete}</modFrete><vol><qVol>12</qVol><pesoL>1100</pesoL><pesoB>${peso}</pesoB></vol></transp>
</infNFe></NFe><protNFe><infProt><chNFe>${ch}</chNFe></infProt></protNFe></nfeProc>` };
};

test('operação: CT-e, MDF-e, GNRE, fatura com cobrança, CIOT, acerto e painel', async () => {
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Transportes', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE TRANSPORTES LTDA', cod_municipio: '4202404', op_simp_nac: 1 }, t)).json.id;
    const base = `/api/empresas/${eid}`;
    const emb = (await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: EMIT, nome: 'Indústria Alfa', inscricao_estadual: '251234567', prazo_pagamento_dias: 20, email: 'fin@alfa.com' }, t)).json;
    const mot = (await call('POST', `${base}/motoristas`, { nome: 'Carlos Silva', cpf: '529.982.247-25', vinculo: 'PROPRIO' }, t)).json;
    const vei = (await call('POST', `${base}/veiculos`, { placa: 'ABC1D23', tipo: 'Truck', vinculo: 'PROPRIO', motorista_id: mot.id }, t)).json;
    const n1 = nfe(201);
    const dados = { embarcador_id: emb.id, origem_cidade: 'Joinville', origem_uf: 'SC', origem_ibge: '4209102', destino_cidade: 'Salvador', destino_uf: 'BA', destino_ibge: '2927408',
      veiculo_id: vei.id, motorista_id: mot.id, valor_frete: 8000, custo_estimado: 3000 };
    const v = (await call('POST', `${base}/viagens`, { ...dados, nfes: [{ xml: n1.xml }] }, t)).json;

    // CT-e a partir da viagem: SC -> BA interestadual, 7%, regime normal, remetente = tomador
    const cte = (await call('POST', `/api/viagens/${v.id}/cte`, undefined, t)).json;
    assert.equal(cte.cfop, '6353');
    assert.equal(cte.cst_icms, '00');
    assert.equal(cte.aliquota_icms, 7);
    assert.equal(cte.valor_icms, 560);
    assert.equal(cte.tomador_papel, 'REMETENTE');
    assert.equal(cte.remetente_nome, 'Industria Alfa SA');
    assert.equal(cte.valor_carga, 15000);
    assert.equal(cte.numero, null, 'número só na transmissão');
    assert.ok(cte.pendencias.some((p: string) => /certificado/.test(p)));
    assert.equal((await call('POST', `/api/viagens/${v.id}/cte`, undefined, t)).json.id, cte.id, 'um CT-e por viagem');
    assert.equal((await call('PUT', `/api/ctes/${cte.id}`, { cfop: '5353', tomador_papel: 'REMETENTE', valor_prestacao: 8000, cst_icms: '00', aliquota_icms: 7 }, t)).status, 400, 'CFOP estadual em prestação interestadual');
    const ed = (await call('PUT', `/api/ctes/${cte.id}`, { cfop: '6352', tomador_papel: 'REMETENTE', valor_prestacao: 8200, cst_icms: '00', aliquota_icms: 12 }, t)).json;
    assert.equal(ed.valor_icms, 984);
    const tr = await call('POST', `/api/ctes/${cte.id}/transmitir`, undefined, t);
    assert.equal(tr.status, 400);
    assert.match(tr.json.erro, /certificado/);

    // MDF-e a partir da viagem, com pendências; transmissão bloqueada
    const md = (await call('POST', `/api/viagens/${v.id}/mdfe`, undefined, t)).json;
    assert.equal(md.uf_ini, 'SC'); assert.equal(md.uf_fim, 'BA'); assert.equal(md.qtd_ctes, 1);
    assert.ok(md.pendencias.some((p: string) => /autorizados/.test(p)));
    const md2 = (await call('PUT', `/api/mdfes/${md.id}`, { veiculo_id: vei.id, motorista_id: mot.id, uf_ini: 'SC', uf_fim: 'BA', percurso: 'pr sp mg', carregamento_ibge: '4209102', descarga_ibge: '2927408', cte_ids: [cte.id] }, t)).json;
    assert.equal(md2.percurso, 'PR,SP,MG');
    assert.equal((await call('POST', `/api/mdfes/${md.id}/encerrar`, { uf: 'BA', ibge: '2927408' }, t)).status, 400, 'rascunho não encerra');

    // GNRE
    const g = (await call('POST', `${base}/gnres`, { cte_id: cte.id, uf_favorecida: 'BA', valor: 984, vencimento: '2026-12-10' }, t)).json;
    assert.equal((await call('POST', `/api/gnres/${g.id}/pagar`, { data: '2026-11-20' }, t)).status, 200);
    assert.equal((await call('GET', `${base}/gnres`, undefined, t)).json[0].status, 'PAGA');

    // fatura: CT-e livres, cobrança no cadastro de clientes, baixa pela cobrança
    assert.equal((await call('GET', `${base}/faturas-frete/ctes-livres`, undefined, t)).json.length, 1);
    const f = (await call('POST', `${base}/faturas-frete`, { embarcador_id: emb.id, cte_ids: [cte.id], gerar_cobranca: true }, t)).json;
    assert.equal(f.numero, 1);
    assert.equal(f.valor, 8200);
    assert.ok(f.cobranca_id, f.aviso ?? '');
    assert.equal((await call('GET', `${base}/faturas-frete/ctes-livres`, undefined, t)).json.length, 0);
    assert.match((await call('POST', `${base}/faturas-frete`, { embarcador_id: emb.id, cte_ids: [cte.id] }, t)).json.erro, /outra fatura/);
    assert.match((await call('POST', `/api/ctes/${cte.id}/cancelar`, undefined, t)).json.erro, /fatura/);
    const { db } = await import('../src/db.js');
    assert.equal((db.prepare('SELECT t.nome FROM cobrancas c JOIN tomadores t ON t.id = c.tomador_id WHERE c.id = ?').get(f.cobranca_id) as any).nome, 'Indústria Alfa');
    db.prepare("UPDATE cobrancas SET status = 'PAGO' WHERE id = ?").run(f.cobranca_id);
    assert.equal((await call('GET', `/api/faturas-frete/${f.id}`, undefined, t)).json.status, 'PAGA');

    // CIOT (12 dígitos) e vale-pedágio
    assert.equal((await call('POST', `${base}/pagamentos-frete`, { viagem_id: v.id, tipo: 'CIOT', numero: '123', data: '2026-11-10' }, t)).status, 400);
    assert.equal((await call('POST', `${base}/pagamentos-frete`, { viagem_id: v.id, tipo: 'VALE_PEDAGIO', operadora: 'Sem Parar', numero: 'VP-998', valor: 420, data: '2026-11-10' }, t)).status, 200);

    // acerto: frete 8000, despesas 1500 (1200 pagas pelo motorista), pedágio 420, comissão 10%, adiantamento 1000
    await call('POST', `/api/viagens/${v.id}/status`, { status: 'EM_TRANSITO', data: '2026-11-10' }, t);
    const ac = (await call('PUT', `/api/viagens/${v.id}/acerto`, { adiantamento: 1000, comissao_pct: 10, km_inicial: 100000, km_final: 102800, itens: [
      { tipo: 'COMBUSTIVEL', valor: 1200, litros: 700, pago_pelo_motorista: true }, { tipo: 'MANUTENCAO', valor: 300, pago_pelo_motorista: false }] }, t)).json;
    assert.equal(ac.resumo.comissao, 800);
    assert.equal(ac.resumo.resultado, 8000 - 1500 - 420 - 800);
    assert.equal(ac.resumo.saldo_motorista, 800 + 1200 - 1000);
    assert.equal(ac.resumo.media_km_l, 4);
    assert.match((await call('POST', `/api/viagens/${v.id}/acerto/fechar`, undefined, t)).json.erro, /depois da entrega/);
    await call('POST', `/api/viagens/${v.id}/status`, { status: 'ENTREGUE', data: '2026-11-12' }, t);
    assert.equal((await call('POST', `/api/viagens/${v.id}/acerto/fechar`, undefined, t)).json.acerto.status, 'FECHADO');
    assert.equal((await call('PUT', `/api/viagens/${v.id}/acerto`, { itens: [] }, t)).status, 400, 'fechado não altera');

    // painel
    const p = (await call('GET', `${base}/painel-transporte`, undefined, t)).json;
    assert.equal(p.porStatus.ENTREGUE, 1);
    assert.equal(p.mes.frete, 8000);
    assert.equal(p.dias.length, 7);
    assert.equal(p.ultimas.length, 1);
    assert.equal(p.docs.cte_rascunho, 1);
  } finally {
    await app.close();
  }
});
