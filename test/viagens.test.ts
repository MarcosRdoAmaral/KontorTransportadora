import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-viagens-'));
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

test('viagens: cadastro, NF-e por XML ou chave, margem, avisos e situação', async () => {
  const { criarApp } = await import('../src/server.js');
  const { chaveNfeValida } = await import('../src/servicos/viagens.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    assert.ok(chaveNfeValida(chave(EMIT, 1)));
    const c1 = chave(EMIT, 1);
    assert.ok(!chaveNfeValida(c1.slice(0, 43) + ((Number(c1[43]) + 1) % 10)), 'DV errado');

    const t = (await call('POST', '/api/setup', { escritorio: 'Transportes', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE TRANSPORTES LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const base = `/api/empresas/${eid}`;
    const emb = (await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: EMIT, nome: 'Indústria Alfa', inscricao_estadual: '251234567' }, t)).json;
    const mot = (await call('POST', `${base}/motoristas`, { nome: 'Carlos Silva', cpf: '529.982.247-25', vinculo: 'AGREGADO', cnh_validade: '2020-01-01' }, t)).json;
    const dono = (await call('POST', `${base}/transportadores`, { tipo_doc: 'CNPJ', documento: '13.269.205/0001-19', nome: 'Rota Sul', rntrc: '01234567' }, t)).json;
    const ag = (await call('POST', `${base}/veiculos`, { placa: 'XYZ5678', tipo: 'Carreta', vinculo: 'AGREGADO', proprietario_id: dono.id, capacidade_kg: 2000, renavam: '12345678901', uf_licenciamento: 'SC', tara_kg: 7000 }, t)).json;
    const proprio = (await call('POST', `${base}/veiculos`, { placa: 'ABC1D23', tipo: 'Truck', vinculo: 'PROPRIO' }, t)).json;

    // leitura do XML: embarcador sugerido pelo modFrete (CIF = emitente), origem e destino com IBGE
    const n1 = nfe(101), n2 = nfe(102, { peso: '1500' });
    const prev = (await call('POST', `${base}/viagens/ler-nfe`, { xml: n1.xml }, t)).json;
    assert.equal(prev.embarcador_sugerido.id, emb.id);
    assert.equal(prev.origem.codMunicipio, '4209102');
    assert.equal(prev.destino.municipio, 'Curitiba');
    assert.equal(prev.nfe.peso_kg, 1200.5);
    assert.equal((await call('POST', `${base}/viagens/ler-nfe`, { xml: nfe(103, { modFrete: '1' }).xml }, t)).json.embarcador_sugerido, null, 'FOB: paga o destinatário, que não é embarcador');

    const dados = {
      embarcador_id: emb.id, produto: 'Peças', origem_cidade: 'Joinville', origem_uf: 'sc', origem_ibge: '4209102', destino_cidade: 'Curitiba', destino_uf: 'PR', destino_ibge: '4106902',
      veiculo_id: ag.id, motorista_id: mot.id, valor_frete: 3000, valor_terceiro: 2200, custo_estimado: 300, coleta_prevista: '2026-11-10', entrega_prevista: '2026-11-11',
    };
    assert.equal((await call('POST', `${base}/viagens`, { ...dados, entrega_prevista: '2026-11-01' }, t)).status, 400, 'entrega antes da coleta');
    assert.equal((await call('POST', `${base}/viagens`, { ...dados, nfes: [{ chave: '123' }] }, t)).status, 400, 'chave inválida');
    assert.equal((await call('POST', `${base}/viagens`, { ...dados, nfes: [{ xml: n1.xml }, { chave: n1.ch }] }, t)).status, 400, 'mesma NF-e duas vezes');
    assert.equal((await call('GET', `${base}/viagens`, undefined, t)).json.length, 0, 'nada gravado depois dos erros');

    const v1 = (await call('POST', `${base}/viagens`, { ...dados, nfes: [{ xml: n1.xml }, { chave: n2.ch }] }, t)).json;
    assert.equal(v1.numero, 1);
    assert.equal(v1.origem_uf, 'SC');
    assert.equal(v1.vinculo, 'AGREGADO');
    assert.equal(v1.margem, 500);
    assert.equal(v1.nfes, 2);
    assert.equal(v1.nfes_incompletas, 1);
    assert.equal(v1.valor_carga, 15000);
    const chaveSo = v1.nfes_lista.find((x: any) => !x.completa);
    assert.equal(chaveSo.numero, '102');
    assert.equal(chaveSo.emitente_documento, EMIT);
    assert.ok(v1.avisos.some((a: string) => /só com a chave/.test(a)));
    assert.ok(v1.avisos.some((a: string) => /CNH de Carlos Silva vencida/.test(a)));

    // XML que chega depois completa a NF-e; peso passa da capacidade do veículo
    const v1b = (await call('POST', `/api/viagens/${v1.id}/nfes`, { nfes: [{ xml: n2.xml }] }, t)).json;
    assert.equal(v1b.nfes_incompletas, 0);
    assert.equal(v1b.peso_kg, 2700.5);
    assert.ok(v1b.avisos.some((a: string) => /acima da capacidade/.test(a)));
    assert.match((await call('POST', `/api/viagens/${v1.id}/nfes`, { nfes: [{ xml: n2.xml }] }, t)).json.erro, /já está nesta viagem/);

    // a mesma NF-e não entra em outra viagem aberta
    const v2 = (await call('POST', `${base}/viagens`, { ...dados, veiculo_id: proprio.id, motorista_id: null }, t)).json;
    assert.equal(v2.numero, 2);
    assert.equal(v2.vinculo, 'PROPRIO');
    assert.equal(v2.valor_terceiro, null, 'frota própria não paga terceiro');
    assert.equal(v2.margem, 2700);
    assert.match((await call('POST', `/api/viagens/${v2.id}/nfes`, { nfes: [{ chave: n1.ch }] }, t)).json.erro, /já está na viagem nº 1/);

    // situação: sem motorista não sai; cancelada é final
    assert.match((await call('POST', `/api/viagens/${v2.id}/status`, { status: 'EM_TRANSITO' }, t)).json.erro, /motorista/);
    let s = (await call('POST', `/api/viagens/${v1.id}/status`, { status: 'EM_TRANSITO', data: '2026-11-10' }, t)).json;
    assert.equal(s.status, 'EM_TRANSITO');
    assert.equal(s.coletada_em, '2026-11-10');
    assert.equal((await call('POST', `/api/viagens/${v1.id}/status`, { status: 'ENTREGUE', data: '2026-11-09' }, t)).status, 400, 'entrega antes da coleta');
    s = (await call('POST', `/api/viagens/${v1.id}/status`, { status: 'ENTREGUE', data: '2026-11-11' }, t)).json;
    assert.equal(s.entregue_em, '2026-11-11');
    assert.deepEqual(s.avisos, []);
    assert.equal((await call('POST', `/api/viagens/${v2.id}/status`, { status: 'CANCELADA' }, t)).json.status, 'CANCELADA');
    assert.equal((await call('POST', `/api/viagens/${v2.id}/status`, { status: 'AGUARDANDO_COLETA' }, t)).status, 400);
    assert.equal((await call('PUT', `/api/viagens/${v2.id}`, dados, t)).status, 400);

    // filtros e busca
    assert.equal((await call('GET', `${base}/viagens?status=ABERTAS`, undefined, t)).json.length, 0);
    assert.equal((await call('GET', `${base}/viagens?status=ENTREGUE`, undefined, t)).json.length, 1);
    assert.equal((await call('GET', `${base}/viagens?q=xyz5678`, undefined, t)).json.length, 1);
    assert.equal((await call('GET', `${base}/viagens?q=102`, undefined, t)).json[0].id, v1.id, 'busca pelo número da NF-e');

    // edição: troca de veículo recalcula o vínculo
    const ed = (await call('PUT', `/api/viagens/${v1.id}`, { ...dados, veiculo_id: proprio.id }, t)).json;
    assert.equal(ed.vinculo, 'PROPRIO');
    assert.equal(ed.margem, 2700);

    // isolamento por empresa e por módulo
    const e2 = (await call('POST', '/api/empresas', { documento: '45.723.174/0001-10', razao_social: 'OUTRA LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    assert.equal((await call('POST', `/api/empresas/${e2}/viagens`, dados, t)).status, 400, 'embarcador de outra empresa');
    const u = await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['viagens'], empresas: [eid] }, t);
    const l1 = (await call('POST', '/api/login', { usuario: 'joao', senha: u.json.senhaProvisoria })).json;
    assert.equal((await call('PUT', '/api/me/senha', { atual: u.json.senhaProvisoria, nova: 'joao-nova-123' }, l1.token)).status, 200);
    const tj = (await call('POST', '/api/login', { usuario: 'joao', senha: 'joao-nova-123' })).json.token;
    assert.equal((await call('GET', `${base}/viagens`, undefined, tj)).status, 200);
    assert.equal((await call('GET', `${base}/veiculos`, undefined, tj)).status, 200, 'lista veículos para escolher');
    assert.equal((await call('POST', `${base}/veiculos`, { placa: 'QQQ1A11', tipo: 'Toco', vinculo: 'PROPRIO' }, tj)).status, 403, 'mas não cadastra');
  } finally {
    await app.close();
  }
});
