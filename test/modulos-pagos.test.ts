import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigo, MODULOS_PAGOS };')();

test('módulos vendidos à parte: liberados no teste, só com o código KG3 na licença ativa, rotas e menu', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-mod-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1',
    KONTOR_MARCAS: fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-')), NFSE_MACHINE_ID: 'guid-modulos' });
  const { criarApp } = await import('../src/server.js');
  const L = await import('../src/licenca.js');
  // o catálogo do gerador é o mesmo do sistema
  assert.deepEqual(Object.keys(ferr.MODULOS_PAGOS).sort(), Object.keys(L.MODULOS_PAGOS).sort());
  // ainda não há módulo à venda neste produto: o teste usa Compras como se fosse um
  L.MODULOS_PAGOS.compras = { nome: 'Compras', resumo: 'Notas de entrada.', rotas: /^\/api\/(empresas\/\d+\/)?compras(\/|$)/ };
  ferr.MODULOS_PAGOS.compras = 'Compras';
  const k = await ferr.gerarChaves();
  L._teste.chave = () => k.publica;
  L._teste.agora = () => new Date('2026-11-02T15:00:00Z');
  L._limparCacheModulos();
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const url = '/api/empresas/1/compras/fornecedores';

    // período de teste: liberado para conhecer
    let lic = (await call('GET', '/api/licenca', undefined, t)).json;
    assert.equal(lic.estado, 'teste'); assert.deepEqual(lic.modulos, ['compras']);
    assert.notEqual((await call('GET', url, undefined, t)).status, 403);
    let me = (await call('GET', '/api/me', undefined, t)).json;
    assert.ok(me.modulos.includes('compras')); assert.deepEqual(me.naoContratados, []);

    // licença paga sem o módulo (KG2): bloqueado, inclusive para o administrador
    const kg2 = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2027-01-31', 'Empresa', 'prata', []);
    assert.match(kg2, /^KG2\./);
    assert.equal((await call('POST', '/api/licenca', { codigo: kg2 }, t)).status, 200);
    const bloq = await call('GET', url, undefined, t);
    assert.equal(bloq.status, 403); assert.match(bloq.json.erro, /Compras não está contratado/);
    me = (await call('GET', '/api/me', undefined, t)).json;
    assert.ok(!me.modulos.includes('compras')); assert.deepEqual(me.naoContratados.map((m: any) => m.id), ['compras']);

    // KG3 com o módulo: liberado na hora
    const kg3 = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2027-01-31', 'Empresa', 'prata', ['compras']);
    assert.match(kg3, /^KG3\./);
    lic = (await call('POST', '/api/licenca', { codigo: kg3 }, t)).json;
    assert.deepEqual(lic.modulos, ['compras']); assert.equal(lic.cliente, 'Empresa'); assert.equal(lic.plano, 'prata');
    assert.notEqual((await call('GET', url, undefined, t)).status, 403);

    // módulo acrescentado sem a assinatura é recusado; licença vencida bloqueia
    const [a, p, g] = kg3.split('.');
    const forjado = [a, Buffer.from(Buffer.from(p, 'base64url').toString().replace('|compras|', '|compras,radar|')).toString('base64url'), g].join('.');
    assert.equal((await call('POST', '/api/licenca', { codigo: forjado }, t)).status, 400);
    L._teste.agora = () => new Date('2027-02-05T15:00:00Z');
    L._limparCacheModulos();
    assert.equal((await call('GET', url, undefined, t)).status, 403);
  } finally {
    delete L.MODULOS_PAGOS.compras;
    await app.close();
  }
});
