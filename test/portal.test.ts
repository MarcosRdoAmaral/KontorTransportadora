import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const xmlNota = (doc: string, chave = '42082032' + '1'.repeat(42)) => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}"><xLocEmi>Itajaí</xLocEmi><xLocPrestacao>Itajaí</xLocPrestacao>
<nNFSe>77</nNFSe><xTribNac>Contabilidade</xTribNac><ambGer>1</ambGer><cStat>100</cStat><dhProc>2026-10-23T19:10:00-03:00</dhProc><nDFSe>77</nDFSe>
<emit><CNPJ>${doc}</CNPJ><xNome>EMPRESA PORTAL LTDA</xNome></emit><valores><vBC>1500.00</vBC><vLiq>1500.00</vLiq></valores>
<DPS versao="1.01"><infDPS Id="DPS420820321${doc}00001000000000000099"><tpAmb>1</tpAmb><dhEmi>2026-10-23T19:09:00-03:00</dhEmi><serie>1</serie><nDPS>99</nDPS><dCompet>2026-10-23</dCompet>
<prest><CNPJ>${doc}</CNPJ></prest><toma><CPF>39053344705</CPF><xNome>Cliente Importado</xNome></toma>
<serv><cServ><cTribNac>171901</cTribNac><xDescServ>Honorários contábeis</xDescServ></cServ></serv>
<valores><vServPrest><vServ>1500.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

test('empresa sem certificado: portal (CNPJ e senha), senha protegida e importação do XML', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-portal-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.body };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { documento: '11.222.333/0001-81', razao_social: 'Empresa Portal Ltda', cod_municipio: '4208203', op_simp_nac: 3, modo_emissao: 'PORTAL' };
    assert.equal((await call('POST', '/api/empresas', base, t)).status, 400, 'portal exige o usuário');
    const eid = (await call('POST', '/api/empresas', { ...base, portal_login: '11222333000181', portal_senha: 'segredo-do-portal' }, t)).json.id;
    const lista = (await call('GET', '/api/empresas', undefined, t)).json.find((e: any) => e.id === eid);
    assert.equal(lista.modo_emissao, 'PORTAL'); assert.equal(lista.tem_senha_portal, true);
    assert.ok(!JSON.stringify(lista).includes('segredo-do-portal') && !('portal_senha_enc' in lista), 'a senha nunca volta para a tela');
    const guardada = (db.prepare('SELECT portal_senha_enc FROM empresas WHERE id = ?').get(eid) as any).portal_senha_enc;
    assert.ok(guardada && !guardada.includes('segredo'), 'senha criptografada no banco');

    // editar sem digitar senha mantém a guardada; voltar para certificado apaga
    assert.equal((await call('PUT', `/api/empresas/${eid}`, { ...base, portal_login: '11222333000181' }, t)).status, 200);
    assert.equal((db.prepare('SELECT portal_senha_enc FROM empresas WHERE id = ?').get(eid) as any).portal_senha_enc, guardada);

    // emissão pelo sistema fica bloqueada com mensagem clara
    const em = await call('POST', '/api/notas', { empresaId: eid, competencia: '2026-10-23', descricao: 'x', valor: 100, cTribNac: '171901' }, t);
    assert.ok([400, 404].includes(em.status));
    if (em.status === 400) assert.match(JSON.stringify(em.json), /portal|certificado|importe/i);

    // importação do XML emitido no portal
    const xml = xmlNota('11222333000181');
    const r = await call('POST', `/api/empresas/${eid}/notas/importar-xml`, { xml }, t);
    assert.equal(r.status, 200, r.body); assert.equal(r.json.numero, '77'); assert.equal(r.json.valor, 1500);
    const nota = db.prepare('SELECT status, n_nfse, valor_servico, tomador_nome FROM notas WHERE empresa_id = ?').get(eid) as any;
    assert.deepEqual({ ...nota }, { status: 'AUTORIZADA', n_nfse: '77', valor_servico: 1500, tomador_nome: 'Cliente Importado' });
    assert.equal((await call('POST', `/api/empresas/${eid}/notas/importar-xml`, { xml }, t)).status, 400, 'duplicada');
    assert.equal((await call('POST', `/api/empresas/${eid}/notas/importar-xml`, { xml: xmlNota('52998224725000100'.slice(0, 14), '9'.repeat(50)) }, t)).status, 400, 'nota de outro CNPJ');

    assert.equal((await call('PUT', `/api/empresas/${eid}`, { ...base, modo_emissao: 'CERTIFICADO' }, t)).status, 200);
    assert.equal((db.prepare('SELECT portal_senha_enc FROM empresas WHERE id = ?').get(eid) as any).portal_senha_enc, null);
  } finally { await app.close(); }
});
