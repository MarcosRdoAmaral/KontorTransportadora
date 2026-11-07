import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { SignedXml } from 'xml-crypto';

// CT-e na SEFAZ (simulada): XML validado no schema oficial, assinatura, mTLS, rejeição, reenvio, duplicidade e cancelamento.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-cte-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40), NFSE_DESKTOP: '1' });
process.env.LICENCA_CHAVE_PUBLICA ??= '';
const CNPJ = '13269205000119';
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 30 -subj "/CN=HORIZONTE TRANSPORTES LTDA:${CNPJ}" 2>/dev/null && openssl pkcs12 -export -inkey ${tmp}/k.pem -in ${tmp}/c.pem -out ${tmp}/a1.pfx -passout pass:1234`);
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/sk.pem -out ${tmp}/sc.pem -days 30 -subj "/CN=127.0.0.1" 2>/dev/null`);
const ESQ = path.resolve('esquemas/PL_CTe_400');
const temXmllint = spawnSync('xmllint', ['--version']).status === 0;

function validar(xml: string, xsd: string) {
  if (!temXmllint) return;
  const f = path.join(tmp, `v${Date.now()}${Math.random()}.xml`);
  fs.writeFileSync(f, xml);
  const r = spawnSync('xmllint', ['--noout', '--schema', path.join(ESQ, xsd), f], { encoding: 'utf8' });
  assert.equal(r.status, 0, `XML fora do schema ${xsd}: ${r.stderr}`);
}
function conferirAssinatura(xml: string) {
  const v = new SignedXml({ publicCert: fs.readFileSync(`${tmp}/c.pem`, 'utf8') });
  v.loadSignature(xml.match(/<Signature[\s\S]*<\/Signature>/)![0]);
  assert.ok(v.checkSignature(xml), 'assinatura deve conferir');
}

type Req = { url: string; acao: string; dados: string };
const recebidos: Req[] = [];
const fila: ((r: Req) => string)[] = [];
const soap = (x: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${x}</soap:Body></soap:Envelope>`;
const NS = 'xmlns="http://www.portalfiscal.inf.br/cte"';
const chaveDe = (xml: string) => xml.match(/Id="CTe(\d{44})"/)?.[1] ?? xml.match(/<chCTe>(\d{44})<\/chCTe>/)?.[1] ?? '';
const retCTe = (cStat: string, xMotivo: string, chave = '', nProt = '') => soap(`<cteRecepcaoResult xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeRecepcaoSincV4"><retCTe ${NS} versao="4.00"><tpAmb>2</tpAmb><cUF>42</cUF><verAplic>SVRS</verAplic><cStat>${nProt ? '100' : cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
  + (nProt ? `<protCTe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chCTe>${chave}</chCTe><dhRecbto>2026-11-06T21:30:00-03:00</dhRecbto><nProt>${nProt}</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe>` : '')
  + '</retCTe></cteRecepcaoResult>');

const srv = https.createServer({ key: fs.readFileSync(`${tmp}/sk.pem`), cert: fs.readFileSync(`${tmp}/sc.pem`), requestCert: true, rejectUnauthorized: false }, (req, res) => {
  const partes: Buffer[] = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => {
    const corpo = Buffer.concat(partes).toString();
    assert.ok((req.socket as any).getPeerCertificate()?.subject?.CN?.includes(CNPJ), 'cliente deve apresentar o A1 (mTLS)');
    const mdfe = (req.url ?? '').startsWith('/mdfe/');
    if (mdfe) assert.match(corpo, /<Header><mdfeCabecMsg xmlns="[^"]+"><cUF>42<\/cUF><versaoDados>3.00<\/versaoDados><\/mdfeCabecMsg><\/Header>/);
    else assert.doesNotMatch(corpo, /cteCabecMsg|<Header/, 'CT-e 4.00 não usa SOAP Header');
    const msg = corpo.match(/<(?:cte|mdfe)DadosMsg xmlns="([^"]+)">([\s\S]*)<\/(?:cte|mdfe)DadosMsg>/)!;
    const dados = (req.url ?? '').endsWith('/recepcao') ? zlib.gunzipSync(Buffer.from(msg[2], 'base64')).toString('utf8') : msg[2];
    const r = { url: req.url ?? '', acao: `${msg[1]} | ${req.headers['content-type']}`, dados };
    recebidos.push(r);
    const prox = fila.shift();
    if (!prox) { res.writeHead(500); res.end('sem resposta programada'); return; }
    res.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' });
    res.end(prox(r));
  });
});

test('CT-e: emissão em homologação com rejeição, reenvio, autorização, duplicidade, XML e cancelamento', async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  process.env.SEFAZ_CTE_URL_TESTE = `https://127.0.0.1:${(srv.address() as any).port}`;
  process.env.SEFAZ_MDFE_URL_TESTE = `https://127.0.0.1:${(srv.address() as any).port}/mdfe`;
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrar, cifrarTexto } = await import('../src/cofre.js');
  const { montarChave } = await import('../src/cte/xml-cte.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.body };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Transportes', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: CNPJ, razao_social: 'HORIZONTE TRANSPORTES LTDA', cod_municipio: '4202404', op_simp_nac: 1 }, t)).json.id;
    db.prepare('UPDATE empresas SET cert_pfx_enc = ?, cert_senha_enc = ?, cert_validade = ?, cert_titular = ? WHERE id = ?')
      .run(cifrar(fs.readFileSync(`${tmp}/a1.pfx`)), cifrarTexto('1234'), '2030-01-01', 'HORIZONTE', eid);
    const base = `/api/empresas/${eid}`;
    const emb = (await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: '45723174000110', nome: 'Indústria Alfa', inscricao_estadual: '251234567', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cep: '89200000', cod_municipio: '4209102', cidade: 'Joinville', uf: 'SC' }, t)).json;
    const mot = (await call('POST', `${base}/motoristas`, { nome: 'Carlos Silva', cpf: '52998224725', vinculo: 'PROPRIO' }, t)).json;
    const vei = (await call('POST', `${base}/veiculos`, { placa: 'ABC1D23', tipo: 'Truck', vinculo: 'PROPRIO' }, t)).json;
    const nfe = (n: number) => {
      const ch = montarChave({ uf: 'SC', aamm: '2610', cnpj: '45723174000110', modelo: '57', serie: 1, numero: n, codigo: String(n) }).replace(/^(.{20})57/, '$155');
      const base43 = ch.slice(0, 43); let s = 0, p = 2;
      for (let i = 42; i >= 0; i--) { s += Number(base43[i]) * p; p = p === 9 ? 2 : p + 1; }
      const chave = base43 + ((s % 11) < 2 ? 0 : 11 - (s % 11));
      return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00"><ide><mod>55</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>`
        + `<emit><CNPJ>45723174000110</CNPJ><xNome>Industria Alfa SA</xNome><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><cMun>4209102</cMun><xMun>Joinville</xMun><UF>SC</UF><CEP>89200000</CEP></enderEmit><IE>251234567</IE></emit>`
        + `<dest><CNPJ>10512356000168</CNPJ><xNome>Comercio Beta</xNome><enderDest><xLgr>Av B</xLgr><nro>200</nro><xBairro>Batel</xBairro><cMun>4106902</cMun><xMun>Curitiba</xMun><UF>PR</UF><CEP>80420000</CEP></enderDest><IE>9012345678</IE></dest>`
        + `<det nItem="1"><prod><xProd>Pecas</xProd><vProd>15000.00</vProd></prod></det><total><ICMSTot><vProd>15000.00</vProd><vNF>15000.00</vNF></ICMSTot></total>`
        + `<transp><modFrete>0</modFrete><vol><qVol>5</qVol><pesoB>1200.5</pesoB></vol></transp></infNFe></NFe><protNFe><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`;
    };
    const viagem = async (n: number) => (await call('POST', `${base}/viagens`, { embarcador_id: emb.id, origem_cidade: 'Joinville', origem_uf: 'SC', origem_ibge: '4209102', destino_cidade: 'Curitiba', destino_uf: 'PR', destino_ibge: '4106902',
      veiculo_id: vei.id, motorista_id: mot.id, valor_frete: 3500, nfes: [{ xml: nfe(n) }] }, t)).json;

    const v1 = await viagem(101);
    const cte = (await call('POST', `/api/viagens/${v1.id}/cte`, undefined, t)).json;
    assert.equal(cte.ambiente, 2, 'empresa nova emite em homologação');
    assert.ok(cte.pendencias.some((p: string) => /RNTRC/.test(p)));
    assert.match((await call('POST', `/api/ctes/${cte.id}/transmitir`, undefined, t)).json.erro, /Inscrição estadual da empresa/);

    // dados do emitente
    assert.equal((await call('PUT', `${base}/emitente-transporte`, { inscricao_estadual: '25.555.555-5', rntrc: '123', logradouro: 'Rua X', bairro: 'Centro', cidade: 'Blumenau', uf: 'SC', ambiente: 2 }, t)).status, 400, 'RNTRC curto');
    assert.equal((await call('PUT', `${base}/emitente-transporte`, { inscricao_estadual: '25.555.555-5', rntrc: '01234567', cep: '89010-000', logradouro: 'Rua X', numero_end: '100', bairro: 'Centro', cidade: 'Blumenau', uf: 'SC', fone: '(47) 3333-4444', ambiente: 2 }, t)).status, 200);
    assert.deepEqual((await call('GET', `/api/ctes/${cte.id}`, undefined, t)).json.pendencias, []);

    // status do serviço
    fila.push(() => soap(`<cteStatusServicoCTResult><retConsStatServCTe ${NS} versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>42</cUF></retConsStatServCTe></cteStatusServicoCTResult>`));
    const st = (await call('GET', `${base}/sefaz-cte-status`, undefined, t)).json;
    assert.equal(st.cStat, '107'); assert.equal(st.ambiente, 'Homologação');
    assert.match(recebidos.at(-1)!.dados, /<consStatServCTe[^>]*versao="4.00"><tpAmb>2<\/tpAmb><cUF>42<\/cUF><xServ>STATUS<\/xServ>/);
    validar(recebidos.at(-1)!.dados, 'consStatServCTe_v4.00.xsd');

    // 1ª tentativa: rejeição — o número fica reservado
    fila.push(() => retCTe('453', 'Rejeicao: Decimais invalidos'));
    const rej = await call('POST', `/api/ctes/${cte.id}/transmitir`, undefined, t);
    assert.equal(rej.status, 400);
    assert.match(rej.json.erro, /não autorizou o CT-e nº 1: 453/);
    const env1 = recebidos.at(-1)!;
    assert.match(env1.acao, /CTeRecepcaoSincV4 \| application\/soap\+xml; charset=utf-8; action="http:\/\/www.portalfiscal.inf.br\/cte\/wsdl\/CTeRecepcaoSincV4\/cteRecepcao"/);
    validar(env1.dados, 'cte_v4.00.xsd');
    conferirAssinatura(env1.dados);
    assert.match(env1.dados, /<xNome>CTE EMITIDO EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL<\/xNome>/);
    assert.match(env1.dados, /<tpAmb>2<\/tpAmb>/);
    assert.match(env1.dados, /<ICMS00><CST>00<\/CST><vBC>3500.00<\/vBC><pICMS>12.00<\/pICMS><vICMS>420.00<\/vICMS><\/ICMS00>/);
    assert.match(env1.dados, /<RNTRC>01234567<\/RNTRC>/);
    assert.match(env1.dados, /<qrCodCTe>https:\/\/dfe-portal.svrs.rs.gov.br\/cte\/qrCode\?chCTe=\d{44}&amp;tpAmb=2<\/qrCodCTe>/);
    let c1 = (await call('GET', `/api/ctes/${cte.id}`, undefined, t)).json;
    assert.equal(c1.status, 'RASCUNHO'); assert.equal(c1.numero, 1); assert.match(c1.ultimo_retorno, /^453/);
    const chave1 = c1.chave;
    assert.equal(chaveDe(env1.dados), chave1);

    // 2ª tentativa: mesmo número e chave, autorizado
    fila.push((r) => retCTe('100', 'Autorizado o uso do CT-e', chaveDe(r.dados), '342260000000001'));
    const ok = (await call('POST', `/api/ctes/${cte.id}/transmitir`, undefined, t)).json;
    assert.equal(ok.status, 'AUTORIZADO');
    assert.equal(ok.numero, 1); assert.equal(ok.chave, chave1); assert.equal(ok.protocolo, '342260000000001');
    const xml = await call('GET', `/api/ctes/${cte.id}/xml`, undefined, t);
    assert.match(xml.body, /^<\?xml[^>]*\?><cteProc xmlns="http:\/\/www.portalfiscal.inf.br\/cte" versao="4.00"><CTe/);
    assert.match(xml.body, /<protCTe versao="4.00"><infProt>.*<nProt>342260000000001<\/nProt>/);
    validar(xml.body, 'procCTe_v4.00.xsd');
    assert.match((await call('POST', `/api/ctes/${cte.id}/transmitir`, undefined, t)).json.erro, /não está em rascunho/);

    // outro CT-e: número 2; SEFAZ responde duplicidade e a consulta traz o protocolo
    const v2 = await viagem(102);
    const cte2 = (await call('POST', `/api/viagens/${v2.id}/cte`, undefined, t)).json;
    fila.push(() => retCTe('204', 'Rejeicao: Duplicidade de CT-e'));
    fila.push((r) => soap(`<cteConsultaCTResult><retConsSitCTe ${NS} versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>100</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo><cUF>42</cUF>`
      + `<protCTe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chCTe>${r.dados.match(/<chCTe>(\d+)/)![1]}</chCTe><dhRecbto>2026-11-06T21:31:00-03:00</dhRecbto><nProt>342260000000002</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe></retConsSitCTe></cteConsultaCTResult>`));
    const dup = (await call('POST', `/api/ctes/${cte2.id}/transmitir`, undefined, t)).json;
    assert.equal(dup.status, 'AUTORIZADO'); assert.equal(dup.numero, 2); assert.equal(dup.protocolo, '342260000000002');
    validar(recebidos.at(-1)!.dados, 'consSitCTe_v4.00.xsd');

    // sem resposta da SEFAZ: mensagem clara, número reservado
    const v3 = await viagem(103);
    const cte3 = (await call('POST', `/api/viagens/${v3.id}/cte`, undefined, t)).json;
    const semResp = (await call('POST', `/api/ctes/${cte3.id}/transmitir`, undefined, t)).json;
    assert.match(semResp.erro, /HTTP 500.*número 3 fica reservado/);

    // MDF-e da viagem 2 (CT-e autorizado): transmissão, schema, encerramento
    const ESQ_MDFE = path.resolve('esquemas/PL_MDFe_300b');
    const validarMdfe = (xml: string, xsd: string) => {
      if (!temXmllint) return;
      const f = path.join(tmp, `m${Date.now()}${Math.random()}.xml`); fs.writeFileSync(f, xml);
      const r = spawnSync('xmllint', ['--noout', '--schema', path.join(ESQ_MDFE, xsd), f], { encoding: 'utf8' });
      assert.equal(r.status, 0, `MDF-e fora do schema ${xsd}: ${r.stderr}`);
    };
    const md = (await call('POST', `/api/viagens/${v2.id}/mdfe`, undefined, t)).json;
    assert.ok(md.pendencias.some((p: string) => /RENAVAM/.test(p)));
    await call('PUT', `/api/veiculos/${vei.id}`, { placa: 'ABC1D23', tipo: 'Truck', vinculo: 'PROPRIO', renavam: '12345678901', uf_licenciamento: 'SC', tara_kg: 6500, capacidade_kg: 14000, tipo_rodado: 'Truck', tipo_carroceria: 'Fechada/Baú' }, t);
    assert.deepEqual((await call('GET', `/api/mdfes/${md.id}`, undefined, t)).json.pendencias, []);
    fila.push((r) => soap(`<mdfeRecepcaoResult xmlns="http://www.portalfiscal.inf.br/mdfe/wsdl/MDFeRecepcaoSinc"><retMDFe xmlns="http://www.portalfiscal.inf.br/mdfe" versao="3.00"><tpAmb>2</tpAmb><cUF>42</cUF><verAplic>SVRS</verAplic><cStat>100</cStat><xMotivo>Autorizado o uso do MDF-e</xMotivo>`
      + `<protMDFe versao="3.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chMDFe>${r.dados.match(/Id="MDFe(\d{44})"/)![1]}</chMDFe><dhRecbto>2026-11-06T21:50:00-03:00</dhRecbto><nProt>942260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do MDF-e</xMotivo></infProt></protMDFe></retMDFe></mdfeRecepcaoResult>`));
    const mdOk = (await call('POST', `/api/mdfes/${md.id}/transmitir`, undefined, t)).json;
    assert.equal(mdOk.status, 'AUTORIZADO', JSON.stringify(mdOk)); assert.equal(mdOk.numero, 1); assert.equal(mdOk.protocolo, '942260000000001');
    const envM = recebidos.at(-1)!;
    assert.match(envM.acao, /MDFeRecepcaoSinc/);
    validarMdfe(envM.dados, 'mdfe_v3.00.xsd');
    conferirAssinatura(envM.dados);
    assert.match(envM.dados, /<veicTracao><placa>ABC1D23<\/placa><RENAVAM>12345678901<\/RENAVAM><tara>6500<\/tara><capKG>14000<\/capKG><condutor><xNome>Carlos Silva<\/xNome><CPF>52998224725<\/CPF><\/condutor><tpRod>01<\/tpRod><tpCar>02<\/tpCar><UF>SC<\/UF><\/veicTracao>/);
    assert.match(envM.dados, new RegExp(`<infCTe><chCTe>${dup.chave}</chCTe></infCTe>`));
    assert.match(envM.dados, /<infLotacao><infLocalCarrega><CEP>89200000<\/CEP><\/infLocalCarrega><infLocalDescarrega><CEP>80420000<\/CEP><\/infLocalDescarrega><\/infLotacao>/);
    validarMdfe((await call('GET', `/api/mdfes/${md.id}/xml`, undefined, t)).body, 'procMDFe_v3.00.xsd');
    fila.push((r) => soap(`<mdfeRecepcaoEventoResult><retEventoMDFe xmlns="http://www.portalfiscal.inf.br/mdfe" versao="3.00"><infEvento><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cOrgao>42</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a MDF-e</xMotivo><chMDFe>${r.dados.match(/<chMDFe>(\d+)/)![1]}</chMDFe><tpEvento>110112</tpEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>2026-11-07T10:00:00-03:00</dhRegEvento><nProt>942260000000005</nProt></infEvento></retEventoMDFe></mdfeRecepcaoEventoResult>`));
    const enc = (await call('POST', `/api/mdfes/${md.id}/encerrar`, { uf: 'PR', ibge: '4106902', data: '2026-11-07' }, t)).json;
    assert.equal(enc.status, 'ENCERRADO');
    validarMdfe(recebidos.at(-1)!.dados, 'eventoMDFe_v3.00.xsd');
    assert.match(recebidos.at(-1)!.dados, /<evEncMDFe><descEvento>Encerramento<\/descEvento><nProt>942260000000001<\/nProt><dtEnc>2026-11-07<\/dtEnc><cUF>41<\/cUF><cMun>4106902<\/cMun><\/evEncMDFe>/);

    // cancelamento por evento
    assert.match((await call('POST', `/api/ctes/${cte.id}/cancelar`, { justificativa: 'curta' }, t)).json.erro, /15 a 255/);
    fila.push((r) => soap(`<cteRecepcaoEventoResult><retEventoCTe ${NS} versao="4.00"><infEvento><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cOrgao>42</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado ao CT-e</xMotivo><chCTe>${r.dados.match(/<chCTe>(\d+)/)![1]}</chCTe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>2026-11-06T21:40:00-03:00</dhRegEvento><nProt>342260000000009</nProt></infEvento></retEventoCTe></cteRecepcaoEventoResult>`));
    const canc = (await call('POST', `/api/ctes/${cte.id}/cancelar`, { justificativa: 'Valor do frete informado errado' }, t)).json;
    assert.equal(canc.status, 'CANCELADO');
    const ev = recebidos.at(-1)!;
    assert.match(ev.acao, /CTeRecepcaoEventoV4/);
    validar(ev.dados, 'eventoCTe_v4.00.xsd');
    conferirAssinatura(ev.dados);
    assert.match(ev.dados, new RegExp(`Id="ID110111${chave1}001".*<evCancCTe><descEvento>Cancelamento</descEvento><nProt>342260000000001</nProt><xJust>Valor do frete informado errado</xJust></evCancCTe>`));
    assert.equal((db.prepare('SELECT cancelamento_protocolo p FROM ctes WHERE id = ?').get(cte.id) as any).p, '342260000000009');
  } finally {
    await app.close();
    srv.close();
  }
});
