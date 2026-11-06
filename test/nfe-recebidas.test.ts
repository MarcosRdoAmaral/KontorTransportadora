import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-rec-'));
process.env.DATABASE_PATH = path.join(tmp, 'db.sqlite');
process.env.STORAGE_DIR = path.join(tmp, 'arq');
process.env.MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_SENHA = 'senha-forte-123';
process.env.NFE_BUSCA_AUTOMATICA = '0';

// certificado A1 da empresa (cliente TLS e assinatura) e certificado do servidor falso (AC própria, só para 127.0.0.1)
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 30 -subj "/CN=EMPRESA TESTE LTDA:11222333000181" 2>/dev/null && openssl pkcs12 -export -inkey ${tmp}/k.pem -in ${tmp}/c.pem -out ${tmp}/t.pfx -passout pass:1234`);
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/sk.pem -out ${tmp}/sc.pem -days 30 -subj "/CN=SEFAZ FALSA" -addext "subjectAltName=IP:127.0.0.1" -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null`);
const certEmpresaPem = fs.readFileSync(`${tmp}/c.pem`, 'utf8');

const CNPJ = '11222333000181';
const CH1 = '42261012345678000195550010000012341000012345'; // resumo → ciência → XML completo → importada → cancelada depois
const CH2 = '42261099888777000166550020000005671000005678'; // resumo → cancelada antes de importar
const CH3 = '42261055444333000122550010000000991000000999'; // ciência recusada → reenvio → busca pela chave
const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';

const resumo = (ch: string, nome: string, valor: string, sit = '1') => `<resNFe ${NS} versao="1.01"><chNFe>${ch}</chNFe><CNPJ>${ch.slice(6, 20)}</CNPJ><xNome>${nome}</xNome><IE>1</IE><dhEmi>2026-10-20T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>${valor}</vNF><digVal>x</digVal><dhRecbto>2026-10-20T10:00:05-03:00</dhRecbto><nProt>1</nProt><cSitNFe>${sit}</cSitNFe></resNFe>`;
const cancelamento = (ch: string) => `<resEvento ${NS} versao="1.01"><cOrgao>42</cOrgao><CNPJ>${ch.slice(6, 20)}</CNPJ><chNFe>${ch}</chNFe><dhEvento>2026-10-21T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Cancelamento</xEvento><dhRecbto>x</dhRecbto><nProt>2</nProt></resEvento>`;
const procNFe = (ch: string, nome: string) => `<nfeProc ${NS} versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">
<ide><cUF>42</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>1</serie><nNF>${Number(ch.slice(25, 34))}</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${ch.slice(6, 20)}</CNPJ><xNome>${nome}</xNome><enderEmit><xMun>Itajaí</xMun><UF>SC</UF></enderEmit></emit>
<dest><CNPJ>${CNPJ}</CNPJ><xNome>EMPRESA TESTE LTDA</xNome></dest>
<det nItem="1"><prod><cProd>A1</cProd><xProd>Papel A4</xProd><NCM>48025610</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>10.0000</qCom><vUnCom>150.0750</vUnCom><vProd>1500.75</vProd></prod></det>
<total><ICMSTot><vProd>1500.75</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vICMS>0.00</vICMS><vIPI>0.00</vIPI><vNF>1500.75</vNF></ICMSTot></total>
<cobr><dup><nDup>001</nDup><dVenc>2026-11-20</dVenc><vDup>1500.75</vDup></dup></cobr>
</infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${ch}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;

const z64 = (xml: string) => zlib.gzipSync(Buffer.from(xml)).toString('base64');
const soap = (corpo: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${corpo}</soap:Body></soap:Envelope>`;
const retDist = (cStat: string, ult: number, max: number, docs: [number, string, string][] = []) => soap(
  `<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult><retDistDFeInt ${NS} versao="1.01"><tpAmb>1</tpAmb><verAplic>T</verAplic><cStat>${cStat}</cStat><xMotivo>motivo ${cStat}</xMotivo><dhResp>x</dhResp><ultNSU>${String(ult).padStart(15, '0')}</ultNSU><maxNSU>${String(max).padStart(15, '0')}</maxNSU>`
  + (docs.length ? `<loteDistDFeInt>${docs.map(([n, s, x]) => `<docZip NSU="${String(n).padStart(15, '0')}" schema="${s}">${z64(x)}</docZip>`).join('')}</loteDistDFeInt>` : '')
  + '</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse>');

/** Confere a assinatura de cada <evento> isoladamente, como a SEFAZ faz. */
function conferirAssinaturas(xml: string) {
  const eventos = xml.match(/<evento [\s\S]*?<\/evento>/g) ?? [];
  for (const ev of eventos) {
    const doc = new DOMParser().parseFromString(ev, 'text/xml');
    const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    const v = new SignedXml({ publicCert: certEmpresaPem });
    v.loadSignature(sig as any);
    assert.ok(v.checkSignature(ev), 'assinatura do evento deve conferir');
  }
  return eventos.length;
}

type Req = { url: string; acao: string; corpo: string };
const recebidos: Req[] = [];
const fila: ((r: Req) => string)[] = [];
const respostaEvento = (codigos: Record<string, string> = {}) => (r: Req) => {
  const chaves = [...r.corpo.matchAll(/<chNFe>(\d{44})<\/chNFe>/g)].map((m) => m[1]);
  return soap(`<nfeRecepcaoEventoNFResult xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><retEnvEvento ${NS} versao="1.00"><idLote>1</idLote><tpAmb>1</tpAmb><verAplic>T</verAplic><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo>`
    + chaves.map((c) => `<retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><verAplic>T</verAplic><cOrgao>91</cOrgao><cStat>${codigos[c] ?? '135'}</cStat><xMotivo>${codigos[c] ? 'Rejeicao: teste' : 'Evento registrado e vinculado a NF-e'}</xMotivo><chNFe>${c}</chNFe><tpEvento>210210</tpEvento></infEvento></retEvento>`).join('')
    + '</retEnvEvento></nfeRecepcaoEventoNFResult>');
};

const srv = https.createServer({ key: fs.readFileSync(`${tmp}/sk.pem`), cert: fs.readFileSync(`${tmp}/sc.pem`), requestCert: true, rejectUnauthorized: false }, (req, res) => {
  const partes: Buffer[] = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => {
    const corpo = Buffer.concat(partes).toString();
    const r = { url: req.url ?? '', acao: String(req.headers['content-type'] ?? ''), corpo };
    recebidos.push(r);
    // a SEFAZ exige o certificado do cliente (mTLS)
    assert.ok((req.socket as any).getPeerCertificate()?.subject?.CN?.includes(CNPJ), 'cliente deve apresentar o A1');
    const prox = fila.shift();
    if (!prox) { res.writeHead(500); res.end('sem resposta programada'); return; }
    res.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' });
    res.end(prox(r));
  });
});

test('NF-e recebidas na SEFAZ: busca por NSU, ciência assinada, XML completo, importação, cancelamento e conexão ICP-Brasil', async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const porta = (srv.address() as any).port;
  process.env.SEFAZ_AN_URL_TESTE = `https://127.0.0.1:${porta}`;
  process.env.SEFAZ_CADEIA_URL_TESTE = `https://127.0.0.1:${porta}/cadeia.zip`; // download "oficial" que falha (servidor não é público)
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  try {
    const call = async (method: any, url: string, body?: any, token?: string) => {
      const r = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.body };
    };
    const token = (await call('POST', '/api/login', { email: 'admin@escritorio.com.br', senha: 'senha-forte-123' })).json.token;
    const emp = await call('POST', '/api/empresas', { documento: '11.222.333/0001-81', razao_social: 'EMPRESA TESTE LTDA', cod_municipio: '4208203', inscricao_municipal: '12345', op_simp_nac: 3, reg_ap_trib_sn: 1, p_tot_trib_sn: 6, ambiente: 2, serie: '1' }, token);
    assert.equal(emp.status, 200, emp.body);
    const eid = emp.json.id;
    const base = `/api/empresas/${eid}/compras/sefaz`;

    // sem certificado: mensagem clara
    let r = await call('GET', base, undefined, token);
    assert.equal(r.json.temCertificado, false);
    assert.equal((await call('POST', `${base}/buscar`, undefined, token)).status, 400);

    const boundary = '----t';
    const mp = (campo: string, nome: string, dados: Buffer, extra = '') => Buffer.concat([
      Buffer.from(`${extra}--${boundary}\r\nContent-Disposition: form-data; name="${campo}"; filename="${nome}"\r\nContent-Type: application/octet-stream\r\n\r\n`), dados, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await app.inject({ method: 'POST', url: `/api/empresas/${eid}/certificado`, payload: mp('arquivo', 't.pfx', fs.readFileSync(`${tmp}/t.pfx`), `--${boundary}\r\nContent-Disposition: form-data; name="senha"\r\n\r\n1234\r\n`), headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.equal(up.statusCode, 200, up.body);

    r = await call('GET', base, undefined, token);
    assert.equal(r.json.temCertificado, true);
    assert.equal(r.json.iniciada, false);
    assert.deepEqual(r.json.notas, []);

    // 1) primeira busca: dois lotes (2 resumos + cancelamento da CH2) e ciência só da CH1
    fila.push(() => retDist('138', 2, 3, [[1, 'resNFe_v1.01.xsd', resumo(CH1, 'PAPELARIA CENTRAL', '1500.75')], [2, 'resNFe_v1.01.xsd', resumo(CH2, 'FORNECEDOR B', '99.90')]]));
    fila.push(() => retDist('138', 3, 3, [[3, 'resEvento_v1.01.xsd', cancelamento(CH2)]]));
    fila.push(respostaEvento());
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.consultou, true);
    assert.equal(r.json.novas, 2);
    assert.equal(r.json.cancelamentos, 1);
    assert.equal(r.json.ciencias, 1);
    assert.ok(r.json.proximaConsulta);
    assert.equal(fila.length, 0);
    assert.equal(recebidos.length, 3);
    const [d1, d2, ev1] = recebidos;
    assert.equal(d1.url, '/distribuicao');
    assert.match(d1.acao, /action="http:\/\/www\.portalfiscal\.inf\.br\/nfe\/wsdl\/NFeDistribuicaoDFe\/nfeDistDFeInteresse"/);
    assert.match(d1.corpo, /^<\?xml[^>]*\?><Envelope xmlns="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"><Body>/);
    assert.match(d1.corpo, /<tpAmb>1<\/tpAmb><cUFAutor>42<\/cUFAutor><CNPJ>11222333000181<\/CNPJ><distNSU><ultNSU>000000000000000<\/ultNSU><\/distNSU>/);
    assert.match(d2.corpo, /<ultNSU>000000000000002<\/ultNSU>/);
    assert.equal(ev1.url, '/evento');
    assert.match(ev1.acao, /NFeRecepcaoEvento4\/nfeRecepcaoEvento"/);
    assert.equal(conferirAssinaturas(ev1.corpo), 1);
    assert.throws(() => conferirAssinaturas(ev1.corpo.replace('<tpAmb>1</tpAmb><CNPJ>', '<tpAmb>2</tpAmb><CNPJ>')), 'adulteração precisa ser detectada');
    assert.match(ev1.corpo, new RegExp(`<infEvento Id="ID210210${CH1}01"><cOrgao>91</cOrgao><tpAmb>1</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${CH1}</chNFe><dhEvento>\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d</dhEvento><tpEvento>210210</tpEvento>`));
    assert.doesNotMatch(ev1.corpo, new RegExp(CH2), 'nota cancelada não recebe ciência');

    r = await call('GET', base, undefined, token);
    const st = (ch: string) => r.json.notas.find((n: any) => n.chave === ch)?.status;
    assert.equal(st(CH1), 'AGUARDANDO_XML');
    assert.equal(st(CH2), 'CANCELADA');
    assert.equal(r.json.notas.find((n: any) => n.chave === CH1).emitente_nome, 'PAPELARIA CENTRAL');
    assert.equal(r.json.notas.find((n: any) => n.chave === CH1).valor, 1500.75);
    assert.equal(r.json.notas.find((n: any) => n.chave === CH1).numero, '1234');
    assert.ok(r.json.proximaConsulta);

    // 2) nova busca dentro da 1 hora: não consulta a SEFAZ (e não há ciência pendente)
    const antes = recebidos.length;
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.json.consultou, false);
    assert.equal(recebidos.length, antes);
    const liberar = () => db.prepare('UPDATE nfe_distribuicao SET proxima_consulta = ? WHERE empresa_id = ?').run(new Date(Date.now() - 1000).toISOString(), eid);

    // 3) depois do intervalo chega o XML completo
    liberar();
    fila.push((q) => { assert.match(q.corpo, /<ultNSU>000000000000003<\/ultNSU>/); return retDist('138', 4, 4, [[4, 'procNFe_v4.00.xsd', procNFe(CH1, 'PAPELARIA CENTRAL LTDA')]]); });
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.json.completas, 1, r.body);
    r = await call('GET', base, undefined, token);
    assert.equal(st(CH1), 'PRONTA');
    assert.equal(r.json.contagem.prontas, 1);
    const xml = await call('GET', `${base}/xml/${CH1}`, undefined, token);
    assert.equal(xml.status, 200);
    assert.match(xml.body, /^<nfeProc/);

    // 4) importação para Compras (a cancelada é recusada)
    r = await call('POST', `${base}/importar`, { chaves: [CH1, CH2], gerarDespesas: true, categoria: 'Material e equipamentos' }, token);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.importadas, 1);
    assert.equal(r.json.resultados[0].ok, true);
    assert.equal(r.json.resultados[0].valor, 1500.75);
    assert.match(r.json.resultados[1].mensagem, /cancelada/);
    const compras = await call('GET', `/api/empresas/${eid}/compras?mes=2026-10`, undefined, token);
    assert.equal(compras.json.compras.length, 1);
    assert.equal(compras.json.compras[0].fornecedor_nome, 'PAPELARIA CENTRAL LTDA');
    assert.equal(compras.json.compras[0].despesas, 1);
    // segunda importação da mesma nota não duplica
    r = await call('POST', `${base}/importar`, { chaves: [CH1], gerarDespesas: false }, token);
    assert.equal(r.json.importadas, 0);
    assert.match(r.json.resultados[0].mensagem, /já foi importada/);
    // a importada sai da lista padrão e aparece em "todas"
    r = await call('GET', base, undefined, token);
    assert.equal(st(CH1), undefined);
    r = await call('GET', `${base}?todas=1`, undefined, token);
    assert.equal(st(CH1), 'IMPORTADA');

    // 5) fornecedor cancela depois da importação: aparece como alerta
    liberar();
    fila.push(() => retDist('138', 5, 5, [[5, 'resEvento_v1.01.xsd', cancelamento(CH1)]]));
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.json.cancelamentos, 1);
    r = await call('GET', base, undefined, token);
    assert.equal(st(CH1), 'CANCELADA_IMPORTADA');
    assert.equal(r.json.contagem.canceladasImportadas, 1);

    // 6) ciência recusada, reenvio e consulta pela chave
    liberar();
    fila.push(() => retDist('138', 6, 6, [[6, 'resNFe_v1.01.xsd', resumo(CH3, 'FORNECEDOR C', '42.00')]]));
    fila.push(respostaEvento({ [CH3]: '596' }));
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.json.cienciasRecusadas, 1);
    r = await call('GET', base, undefined, token);
    assert.equal(st(CH3), 'CIENCIA_RECUSADA');
    fila.push(respostaEvento());
    r = await call('POST', `${base}/ciencia`, { chaves: [CH3] }, token);
    assert.equal(r.json.consultou, false, 'reenvio da ciência não consulta a distribuição (intervalo)');
    assert.equal(r.json.ciencias, 1);
    fila.push((q) => { assert.match(q.corpo, new RegExp(`<consChNFe><chNFe>${CH3}</chNFe></consChNFe>`)); return retDist('138', 0, 0, [[0, 'procNFe_v4.00.xsd', procNFe(CH3, 'FORNECEDOR C LTDA')]]); });
    r = await call('POST', `${base}/chave`, { chave: CH3.replace(/(\d{4})/g, '$1 ') }, token);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.nota.status, 'PRONTA');
    fila.push(() => retDist('137', 0, 0));
    assert.match((await call('POST', `${base}/chave`, { chave: '4'.repeat(44) }, token)).json.erro, /não encontrou/);

    // 7) ocultar
    assert.equal((await call('POST', `${base}/ocultar`, { chave: CH3, oculta: true }, token)).status, 200);
    r = await call('GET', base, undefined, token);
    assert.equal(st(CH3), undefined);

    // 8) consumo indevido (656) e rejeição
    liberar();
    fila.push(() => retDist('656', 6, 6));
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.match(r.json.aviso, /aguardar 1 hora/);
    assert.ok(r.json.proximaConsulta);
    liberar();
    fila.push(() => retDist('589', 0, 0));
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.status, 502);
    assert.match(r.json.erro, /589/);
    r = await call('GET', base, undefined, token);
    assert.match(r.json.ultimoErro.mensagem, /589/);
    assert.equal(Number(db.prepare('SELECT ult_nsu FROM nfe_distribuicao WHERE empresa_id = ?').get(eid).ult_nsu), 6, 'NSU não volta');

    // 9) busca automática respeita a configuração
    const { buscarAutomaticamente } = await import('../src/servicos/nfe-recebidas.js');
    liberar();
    assert.equal((await call('PUT', `${base}/config`, { automatica: false }, token)).status, 200);
    let n = recebidos.length;
    await buscarAutomaticamente();
    assert.equal(recebidos.length, n, 'desligada: não consulta');
    await call('PUT', `${base}/config`, { automatica: true }, token);
    fila.push(() => retDist('137', 6, 6));
    await buscarAutomaticamente();
    assert.equal(recebidos.length, n + 1, 'ligada: consulta uma vez');
    await buscarAutomaticamente();
    assert.equal(recebidos.length, n + 1, 'e respeita o intervalo');

    // 10) permissões: sem o módulo Compras não acessa; com Compras não mexe na conexão (só administrador)
    const { hashSenha } = await import('../src/auth.js');
    for (const [id, perm] of [[50, '["painel"]'], [51, '["compras"]']] as const) {
      db.prepare("INSERT INTO usuarios (id, escritorio_id, nome, email, senha_hash, papel, login, tipo, permissoes) VALUES (?, 1, 'U', ?, ?, 'operador', ?, 'normal', ?)").run(id, `u${id}@x.com`, hashSenha('senha-forte-123'), `U${id}`, perm);
      db.prepare('INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES (?, ?)').run(id, eid);
    }
    const tk = async (login: string) => (await call('POST', '/api/login', { usuario: login, senha: 'senha-forte-123' })).json.token;
    const t50 = await tk('U50'), t51 = await tk('U51');
    assert.equal((await call('GET', base, undefined, t50)).status, 403);
    assert.equal((await call('GET', base, undefined, t51)).status, 200);
    assert.equal((await call('POST', `${base}/importar`, { chaves: [CH3] }, t51)).status, 200);
    assert.equal((await call('GET', '/api/sefaz/conexao', undefined, t51)).status, 403);

    // 11) cadeia ICP-Brasil: com a verificação do servidor ligada, o servidor (AC desconhecida) é recusado,
    //     o download automático falha, e o administrador resolve enviando a cadeia
    process.env.SEFAZ_AN_VERIFICAR_TESTE = '1';
    liberar();
    n = recebidos.length;
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.status, 502, r.body);
    assert.equal(r.json.detalhes?.cadeia, true);
    assert.match(r.json.erro, /cadeia ICP-Brasil/);
    assert.equal(recebidos.length, n, 'nada chegou ao servidor não confiável');
    let c = await call('GET', '/api/sefaz/conexao', undefined, token);
    assert.equal(c.json.cadeiaIcp, 0);
    assert.equal(c.json.verificarServidor, true);
    // arquivo sem AC é recusado; zip com a AC é aceito
    const envio = (dados: Buffer, nome: string) => app.inject({ method: 'POST', url: '/api/sefaz/conexao/cadeia', payload: mp('arquivo', nome, dados), headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/fk.pem -out ${tmp}/folha.pem -days 30 -subj "/CN=folha" -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null`);
    assert.equal((await envio(fs.readFileSync(`${tmp}/folha.pem`), 'folha.pem')).statusCode, 400);
    const zip = Buffer.from(zipSync({ 'ICP/raiz.crt': new Uint8Array(new crypto.X509Certificate(fs.readFileSync(`${tmp}/sc.pem`)).raw), 'leia.txt': new TextEncoder().encode('x') }));
    const ok = await envio(zip, 'ACcompactado.zip');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().cadeiaIcp, 1);
    assert.deepEqual(ok.json().raizesIcp, ['SEFAZ FALSA']);
    fila.push(() => retDist('137', 6, 6));
    r = await call('POST', `${base}/buscar`, undefined, token);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.consultou, true);
    // sem a cadeia e com a verificação desligada pelo administrador também conecta (último recurso)
    assert.equal((await call('DELETE', '/api/sefaz/conexao/cadeia', undefined, token)).json.cadeiaIcp, 0);
    c = await call('PUT', '/api/sefaz/conexao', { verificarServidor: false }, token);
    assert.equal(c.json.verificarServidor, false);
    liberar();
    fila.push(() => retDist('137', 6, 6));
    assert.equal((await call('POST', `${base}/buscar`, undefined, token)).status, 200);
    await call('PUT', '/api/sefaz/conexao', { verificarServidor: true }, token);
    delete process.env.SEFAZ_AN_VERIFICAR_TESTE;
  } finally {
    await app.close();
    srv.close();
    srv.closeAllConnections();
  }
});

test('cadeia ICP-Brasil: leitura de PEM, DER, PKCS#7 e ZIP; download oficial', async () => {
  const { extrairCertificadosAc, baixarCadeiaIcp, cadeiaIcpGuardada, apagarCadeiaIcp } = await import('../src/nfe/confianca.js');
  const pem = fs.readFileSync(`${tmp}/sc.pem`);
  const der = Buffer.from(new crypto.X509Certificate(pem).raw);
  assert.equal(extrairCertificadosAc(pem).length, 1);
  assert.equal(extrairCertificadosAc(der).length, 1);
  assert.equal(extrairCertificadosAc(Buffer.concat([pem, fs.readFileSync(`${tmp}/c.pem`)])).length, 2);
  execSync(`openssl crl2pkcs7 -nocrl -certfile ${tmp}/sc.pem -out ${tmp}/c.p7b -outform DER && openssl crl2pkcs7 -nocrl -certfile ${tmp}/sc.pem -out ${tmp}/c.p7b.pem`);
  assert.equal(extrairCertificadosAc(fs.readFileSync(`${tmp}/c.p7b`)).length, 1);
  assert.equal(extrairCertificadosAc(fs.readFileSync(`${tmp}/c.p7b.pem`)).length, 1);
  assert.equal(extrairCertificadosAc(Buffer.from('lixo')).length, 0);

  // download: servidor HTTP local fazendo o papel do repositório do ITI. Só entra o que encadeia até uma raiz confiável:
  // raiz de teste → AC intermediária (aceita) e uma AC solta, autoassinada por outra chave (recusada).
  execSync(`cd ${tmp} && openssl req -x509 -newkey rsa:2048 -nodes -keyout rk.pem -out raiz.pem -days 30 -subj "/CN=RAIZ TESTE" -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null`
    + ` && openssl req -newkey rsa:2048 -nodes -keyout ik.pem -out i.csr -subj "/CN=AC SSL TESTE" 2>/dev/null`
    + ` && printf "basicConstraints=critical,CA:TRUE\n" > ext.cnf && openssl x509 -req -in i.csr -CA raiz.pem -CAkey rk.pem -CAcreateserial -out inter.pem -days 30 -extfile ext.cnf 2>/dev/null`);
  const inter = fs.readFileSync(`${tmp}/inter.pem`);
  const raizTeste = fs.readFileSync(`${tmp}/raiz.pem`, 'utf8');
  let pacote = Buffer.from(zipSync({ 'a/inter.crt': new Uint8Array(new crypto.X509Certificate(inter).raw), 'a/solta.cer': new Uint8Array(der), 'leia.txt': new TextEncoder().encode('x') }));
  const ITI = http.createServer((req, res) => { res.end(pacote); });
  await new Promise<void>((r) => ITI.listen(0, '127.0.0.1', r));
  const fecharIti = () => new Promise<void>((ok) => { if (!ITI.listening) return ok(); ITI.close(() => ok()); ITI.closeAllConnections(); });
  try {
  process.env.SEFAZ_CADEIA_URL_TESTE = `http://127.0.0.1:${(ITI.address() as any).port}/ACcompactado.zip`;
  apagarCadeiaIcp();
  let r = await baixarCadeiaIcp(undefined, [raizTeste]);
  assert.equal(r.lidos, 2);
  assert.equal(r.guardados, 1, 'só a AC que encadeia até a raiz');
  assert.match(cadeiaIcpGuardada()[0], /BEGIN CERTIFICATE/);
  assert.equal(new crypto.X509Certificate(cadeiaIcpGuardada()[0]).subject, 'CN=AC SSL TESTE');
  assert.equal((await baixarCadeiaIcp(undefined, [raizTeste])).guardados, 0, 'não duplica');
  // com as raízes ICP-Brasil reais, nada do pacote falso entra
  apagarCadeiaIcp();
  r = await baixarCadeiaIcp();
  assert.equal(r.guardados, 0);
  assert.match(r.falhas.join(), /nenhum certificado do arquivo encadeia/);
  // falha de rede vira texto legível
  await fecharIti();
  const livre = http.createServer();
  await new Promise<void>((ok) => livre.listen(0, '127.0.0.1', ok));
  const portaLivre = (livre.address() as any).port;
  await new Promise<void>((ok) => livre.close(() => ok()));
  process.env.SEFAZ_CADEIA_URL_TESTE = `http://127.0.0.1:${portaLivre}/ACcompactado.zip`;
  r = await baixarCadeiaIcp();
  assert.match(r.falhas.join(), /^não foi possível baixar http:\/\/127\.0\.0\.1:\d+\/ACcompactado\.zip: conexão recusada/);
  pacote = Buffer.alloc(0);
  } finally { await fecharIti(); }
});

test('cadeia ICP-Brasil embutida: impressões digitais, assinaturas e uso na conexão', async () => {
  const { CADEIA_ICP_EMBUTIDA } = await import('../src/nfe/icp-brasil-embutida.js');
  const { autoridadesSefaz, statusConfianca } = await import('../src/nfe/confianca.js');
  // SHA-256 conferidos no ACcompactado.zip do ITI (via @sinete/cert e @nfewizard/shared)
  const esperado: Record<string, string> = {
    'Autoridade Certificadora Raiz Brasileira v5': 'caa53fc6091c6951887c976e378f6ef89aa6377c55d97b6475422b71ed7e9b17',
    'Autoridade Certificadora Raiz Brasileira v10': '6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6',
    'Autoridade Certificadora Raiz Brasileira v11': '1406710058180fa4081aab3f246f1702429c552a11fa3143b84c88cb3ab8e5e7',
    'Autoridade Certificadora Raiz Brasileira v12': 'd8478e37ce19c690cf657381e68fe600e4e1a042536830f06847e03e554c4b01',
    'Autoridade Certificadora do SERPRO SSLv1': '08fc942d5176e568acbef9c595f36a20de6acf9ea30c6f5fcedd48216ed5b070',
    'AC SOLUTI SSL EV G4': '8e30f7f0b678ca1440a94a5be416bed9ae5aff7f0f2e08d4bbe28af2c8eb8660',
    'AC Certisign ICP-Brasil SSL EV G4': '1e36dcc28bc6fbdb23d5df49e55cfb6b27e29d99cc0d555226c2e1e07b838a23',
  };
  assert.equal(CADEIA_ICP_EMBUTIDA.length, Object.keys(esperado).length);
  const v10 = new crypto.X509Certificate(CADEIA_ICP_EMBUTIDA.find((c) => c.nome.endsWith('v10'))!.pem);
  for (const c of CADEIA_ICP_EMBUTIDA) {
    const x = new crypto.X509Certificate(c.pem);
    assert.equal(x.fingerprint256.replace(/:/g, '').toLowerCase(), esperado[c.nome], c.nome);
    assert.equal(c.sha256, esperado[c.nome]);
    assert.ok(x.ca, `${c.nome} é AC`);
    if (c.tipo === 'raiz') assert.ok(x.verify(x.publicKey), `${c.nome} autoassinada`);
    else assert.ok(x.checkIssued(v10) && x.verify(v10.publicKey), `${c.nome} emitida pela raiz v10`);
  }
  const ca = autoridadesSefaz();
  for (const c of CADEIA_ICP_EMBUTIDA) assert.ok(ca.includes(c.pem), `${c.nome} vai para a conexão com a SEFAZ`);
  const st = statusConfianca();
  assert.equal(st.embutida.length, 7);
  assert.match(st.urlPacote, /^http:\/\/acraiz\.icpbrasil\.gov\.br\/credenciadas\/CertificadosAC-ICP-Brasil\/ACcompactado\.zip$/);
});
