import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Tenta burlar o período de teste e confere que o controle vale pela API, como no aplicativo instalado.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burla-'));
const marcas1 = path.join(tmp, 'm1'), marcas2 = path.join(tmp, 'm2');
process.env.DATABASE_PATH = path.join(tmp, 'db.sqlite');
process.env.STORAGE_DIR = path.join(tmp, 'arq');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.SESSION_SECRET = 'x';
process.env.NFSE_DESKTOP = '1';
process.env.NFSE_MACHINE_ID = 'guid-estavel-do-computador';
process.env.KONTOR_MARCAS = [marcas1, marcas2].join(path.delimiter);
delete process.env.ADMIN_SENHA;

test('teste de 7 dias: não reinicia ao apagar o banco, não volta o relógio e não aceita marca adulterada', async () => {
  const L = await import('../src/licenca.js');
  const { db } = await import('../src/db.js');
  const { criarApp } = await import('../src/server.js');
  let agora = new Date('2026-06-01T15:00:00Z');
  L._teste.agora = () => agora;
  assert.ok(L._teste.chave(), 'a chave de licença do aplicativo precisa estar embutida');

  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const s = await call('POST', '/api/setup', { escritorio: 'Contábil', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' });
    const token = s.json.token;

    // dentro do teste: 1 empresa e 2 clientes, nada além
    assert.equal(L.statusLicenca().estado, 'teste');
    const emp = { documento: '11.222.333/0001-81', razao_social: 'Padaria', cod_municipio: '4208203', op_simp_nac: 3 };
    const e1 = await call('POST', '/api/empresas', emp, token);
    assert.equal(e1.status, 200);
    const e2 = await call('POST', '/api/empresas', { ...emp, documento: '10.512.356/0001-68', razao_social: 'Outra' }, token);
    assert.equal(e2.status, 402);
    assert.match(e2.json.erro, /plano Teste permite 1 empresa/);
    const cli = (doc: string) => call('POST', `/api/empresas/${e1.json.id}/tomadores`, { tipo_doc: 'CNPJ', documento: doc, nome: 'Cliente ' + doc, cep: '89200000', fone: '47999999999' }, token);
    assert.equal((await cli('00.360.305/0001-04')).status, 200);
    assert.equal((await cli('12.345.678/0001-95')).status, 200);
    const c3 = await cli('00.000.000/0001-91');
    assert.equal(c3.status, 402, 'o terceiro cliente passa do limite do teste');
    assert.ok(fs.existsSync(path.join(marcas1, 'kg-lic.dat')) && fs.existsSync(path.join(marcas2, 'kg-lic.dat')));

    // passados os 7 dias a emissão fecha pela API
    agora = new Date('2026-06-09T15:00:00Z');
    assert.equal(L.statusLicenca().estado, 'vencida');
    const nota = await call('POST', '/api/notas', { empresaId: e1.json.id, competencia: '2026-06-09', descricao: 'Serviço', valor: 100 }, token);
    assert.equal(nota.status, 402);
    assert.match(nota.json.erro, /teste terminou/);

    // tentativa 1: zerar os dados de licença no banco
    db.prepare('UPDATE licenca SET inicio_teste = NULL, ultimo_visto = NULL').run();
    assert.equal(L.statusLicenca().estado, 'vencida', 'limpar as colunas não dá teste novo');
    db.prepare('DELETE FROM licenca').run();
    assert.equal(L.statusLicenca().estado, 'vencida', 'apagar a linha não dá teste novo');

    // tentativa 2: empurrar o início do teste para o futuro no banco
    db.prepare("UPDATE licenca SET inicio_teste = '2026-06-09' WHERE id = 1").run();
    assert.equal(L.statusLicenca().estado, 'vencida', 'vale o início mais antigo');

    // tentativa 3: apagar uma das marcas (a outra restaura)
    fs.rmSync(path.join(marcas1, 'kg-lic.dat'));
    assert.equal(L.statusLicenca().estado, 'vencida');
    assert.ok(fs.existsSync(path.join(marcas1, 'kg-lic.dat')), 'a marca apagada é recriada');

    // tentativa 4: voltar o relógio do Windows
    agora = new Date('2026-06-02T15:00:00Z');
    db.prepare('UPDATE licenca SET ultimo_visto = NULL').run();
    assert.equal(L.statusLicenca().estado, 'relogio', 'a marca guarda a última data de uso mesmo sem o banco');
    agora = new Date('2026-06-09T15:00:00Z');

    // tentativa 5: editar o início na marca para uma data recente
    const f = path.join(marcas2, 'kg-lic.dat');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('2026-06-01', '2026-06-09'));
    const st = L.statusLicenca();
    assert.equal(st.estado, 'vencida');
    assert.match(st.mensagem, /foram alterados/);
    assert.equal(st.permitido, false);

    // tentativa 6: variáveis de ambiente não desligam o controle no aplicativo instalado
    process.env.KONTOR_EMPACOTADO = '1';
    process.env.LICENCA_CHAVE_PUBLICA = '';
    assert.ok(L._teste.chave(), 'a chave embutida vale, mesmo com a variável vazia');
    process.env.LICENCA_CHAVE_PUBLICA = 'outra';
    assert.notEqual(L._teste.chave(), 'outra');
    delete process.env.KONTOR_EMPACOTADO;
  } finally { await app.close(); }
});
