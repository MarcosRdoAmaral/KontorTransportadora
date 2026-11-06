import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.LICENCA_CHAVE_PUBLICA ??= ''; // sem controle de licença neste teste
import { zipSync, strToU8 } from 'fflate';

/** xlsx mínimo: cabeçalho, CNPJ como número (sem o zero à esquerda), CNPJ como texto formatado, CNPJ inválido, CPF, repetido. */
function xlsx(): Buffer {
  const textos = ['CNPJ', 'Nome', 'Papelaria Central', '12.345.678/0001-95', 'Sem Nome Ltda', 'Fulano de Tal', '529.982.247-25', '00.000.000/0000-00'];
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2"><v>360305000104</v></c><c r="B2" t="s"><v>2</v></c></row>
    <row r="3"><c r="A3" t="s"><v>3</v></c></row>
    <row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4" t="s"><v>4</v></c></row>
    <row r="5"><c r="A5" t="s"><v>6</v></c><c r="B5" t="s"><v>5</v></c></row>
    <row r="6"><c r="A6" t="s"><v>3</v></c></row>
  </sheetData></worksheet>`;
  const z = zipSync({
    'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clientes" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${textos.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  return Buffer.from(z);
}

test('importação de clientes por planilha: leitura, consulta do CNPJ e marca "falta conferir"', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-imp-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  // Receita simulada: só o CNPJ 191 (Banco do Brasil) e o 12345678000195 respondem; o resto 404
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const dados = u.includes('00360305000104') ? { razao_social: 'CAIXA ECONOMICA FEDERAL', nome_fantasia: 'BB', descricao_situacao_cadastral: 'ATIVA', cep: '70073901', codigo_municipio_ibge: 5300108, municipio: 'BRASILIA', uf: 'DF', logradouro: 'Q SAUN', descricao_tipo_de_logradouro: 'QUADRA', numero: '5', bairro: 'ASA NORTE', email: 'bb@bb.com.br', ddd_telefone_1: '6133493000', opcao_pelo_simples: false }
      : u.includes('12345678000195') ? { razao_social: 'PAPELARIA CENTRAL LTDA', descricao_situacao_cadastral: 'ATIVA', municipio: 'FLORIANOPOLIS', uf: 'SC', cep: '88000000' } : null;
    return { status: dados ? 200 : 404, json: async () => dados } as any;
  }) as any;
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const token = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const emp = (await call('POST', '/api/empresas', { documento: '10.512.356/0001-68', razao_social: 'BARBIERI', cod_municipio: '4208203', op_simp_nac: 3 }, token)).json.id;
    const base = `/api/empresas/${emp}/tomadores/planilha`;
    const a = await call('POST', `${base}/analisar`, { nome: 'clientes.xlsx', base64: xlsx().toString('base64') }, token);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    const por = (s: string) => a.json.linhas.filter((l: any) => l.situacao === s);
    // 360305000104 (zeros à esquerda recuperados), 12.345.678/0001-95 e o CPF são novos; o repetido e o CNPJ zerado são recusados
    assert.deepEqual(por('NOVO').map((l: any) => l.documento), ['00360305000104', '12345678000195', '52998224725']);
    assert.equal(por('NOVO')[0].nome, 'Papelaria Central'); // o nome da planilha acompanha o CNPJ da linha
    assert.equal(por('REPETIDO').length, 1); assert.equal(por('INVALIDO').length, 1);

    const imp = await call('POST', `${base}/importar`, { itens: por('NOVO').map((l: any) => ({ documento: l.documento, nome: l.nome })) }, token);
    assert.equal(imp.status, 200, JSON.stringify(imp.json));
    assert.equal(imp.json.resultados.every((r: any) => r.ok), true, JSON.stringify(imp.json));
    const t = db.prepare("SELECT * FROM tomadores WHERE documento = '00360305000104'").get() as any;
    assert.equal(t.nome, 'CAIXA ECONOMICA FEDERAL'); assert.equal(t.cod_municipio, '5300108'); assert.equal(t.logradouro, 'QUADRA Q SAUN'); assert.equal(t.email, 'bb@bb.com.br');
    assert.equal(t.conferir, 1); assert.equal(t.tipo_doc, 'CNPJ');
    const p = db.prepare("SELECT * FROM tomadores WHERE documento = '12345678000195'").get() as any;
    assert.match(p.conferir_motivo, /endereço incompleto/); assert.match(p.conferir_motivo, /sem e-mail/);
    const cpf = db.prepare("SELECT * FROM tomadores WHERE documento = '52998224725'").get() as any;
    assert.equal(cpf.nome, 'Fulano de Tal'); assert.equal(cpf.tipo_doc, 'CPF'); assert.equal(cpf.conferir, 1);

    // reimportar: já cadastrados
    const de_novo = await call('POST', `${base}/analisar`, { nome: 'clientes.xlsx', base64: xlsx().toString('base64') }, token);
    assert.equal(de_novo.json.resumo.novos, 0); assert.equal(de_novo.json.resumo.existentes, 4);
    // marcar como conferido pelo cadastro
    const lista = (await call('GET', `/api/empresas/${emp}/tomadores`, undefined, token)).json;
    assert.equal(lista.filter((x: any) => x.conferir).length, 3);
    const alvo = lista.find((x: any) => x.documento === '00360305000104');
    const put = await call('PUT', `/api/tomadores/${alvo.id}`, { tipo_doc: 'CNPJ', documento: alvo.documento, nome: alvo.nome, conferido: true }, token);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal((db.prepare('SELECT conferir FROM tomadores WHERE id = ?').get(alvo.id) as any).conferir, 0);
    // CSV também
    const csv = await call('POST', `${base}/analisar`, { nome: 'c.csv', base64: Buffer.from('cnpj;nome\n11.222.333/0001-81;Cliente CSV\n').toString('base64') }, token);
    assert.equal(csv.json.resumo.novos, 1); assert.equal(csv.json.linhas[0].nome, 'Cliente CSV');
  } finally { globalThis.fetch = original; await app.close(); }
});
