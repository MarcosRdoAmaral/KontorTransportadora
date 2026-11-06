import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Banco de uma instalação antiga: master criado com a senha fixa 270820 (que esteve no código público).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-suporte-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x',
  NFSE_DESKTOP: '1', KONTOR_MARCAS: fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-')), NFSE_MACHINE_ID: 'computador-do-suporte',
});

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigoSuporte };')();

test('master sem senha fixa: só entra com código de suporte assinado, deste computador e dentro da validade', async () => {
  const k = await ferr.gerarChaves();
  const L = await import('../src/licenca.js');
  L._teste.chave = () => k.publica;
  const { db, migrar } = await import('../src/db.js');
  const { hashSenha, conferirSenha } = await import('../src/auth.js');
  migrar();
  // simula a instalação antiga: escritório + master com a senha fixa antiga e um admin
  db.prepare("INSERT INTO escritorios (id, nome) VALUES (1, 'Antigo')").run();
  db.prepare("INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo, mestre) VALUES (1,'Kontor (master)','kontor@kontor.local','KONTOR',?,'admin','adm',1)").run(hashSenha('270820'));
  db.prepare("INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo) VALUES (1,'Ana','ana@x.com','ANA',?,'admin','adm')").run(hashSenha('senha-segura-1'));

  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  const { _zerarFalhas } = await import('../src/servicos/usuarios.js');
  try {
    // a senha antiga deixou de valer ao iniciar
    const m = db.prepare('SELECT senha_hash FROM usuarios WHERE mestre = 1').get() as any;
    assert.equal(conferirSenha('270820', m.senha_hash), false);
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: '270820' })).status, 401);
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: '' })).status, 401);
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: '!' })).status, 401, 'o marcador "sem senha" não serve de senha');

    const computador = L.codigoDoComputador();
    const valido = await ferr.emitirCodigoSuporte(k.privada, computador, 4);
    _zerarFalhas();
    const ok = await call('POST', '/api/login', { usuario: 'kontor', senha: valido.codigo });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.usuario.tipo, 'adm');
    assert.equal(ok.json.trocar_senha, false);
    // a sessão do suporte acaba junto com o código
    const exp = JSON.parse(Buffer.from(ok.json.token.split('.')[0], 'base64url').toString()).exp;
    assert.ok(exp <= Math.floor(Date.parse(valido.expira) / 1000));
    assert.equal((await call('GET', '/api/me', undefined, ok.json.token)).status, 200);
    // o master não cria senha para si
    assert.equal((await call('PUT', '/api/me/senha', { atual: valido.codigo, nova: 'uma-senha-qualquer' }, ok.json.token)).status, 400);

    // outro computador, vencido, longo demais, adulterado, outra chave: recusados com a mesma resposta
    _zerarFalhas();
    const outroPc = await ferr.emitirCodigoSuporte(k.privada, '0000-1111-2222-3333', 4);
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: outroPc.codigo })).status, 401);
    const vencido = await ferr.emitirCodigoSuporte(k.privada, computador, 1, new Date(Date.now() - 2 * 3600e3));
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: vencido.codigo })).status, 401);
    const longo = await ferr.emitirCodigoSuporte(k.privada, computador, 24, new Date(Date.now() + 6 * 3600e3));
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: longo.codigo })).status, 401, 'expiração além de 24 h a partir de agora');
    const [p0, carga, sig] = valido.codigo.split('.');
    // estica a validade em 1 hora mantendo a assinatura original
    const campos = Buffer.from(carga, 'base64url').toString().split('|');
    campos[2] = new Date(Date.parse(campos[2]) + 3600e3).toISOString();
    const adulterada = Buffer.from(campos.join('|')).toString('base64url');
    assert.notEqual(adulterada, carga);
    _zerarFalhas();
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: `${p0}.${adulterada}.${sig}` })).status, 401);
    const outraChave = await ferr.gerarChaves();
    const falso = await ferr.emitirCodigoSuporte(outraChave.privada, computador, 4);
    _zerarFalhas();
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: falso.codigo })).status, 401, 'assinado por outra chave');
    // um código de suporte não serve para outro usuário
    _zerarFalhas();
    assert.equal((await call('POST', '/api/login', { usuario: 'ANA', senha: valido.codigo })).status, 401);
    assert.equal((await call('POST', '/api/login', { usuario: 'ANA', senha: 'senha-segura-1' })).status, 200);

    // sem chave pública configurada não há acesso de suporte
    L._teste.chave = () => '';
    _zerarFalhas();
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: valido.codigo })).status, 401);
  } finally { await app.close(); }
});
