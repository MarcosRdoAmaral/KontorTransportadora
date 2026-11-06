import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')), 'a.db');
process.env.MASTER_KEY ??= 'a'.repeat(64);
process.env.SESSION_SECRET ??= 'b'.repeat(32);
process.env.KONTOR_MARCAS = fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-')); // marcas do teste fora do banco
process.env.NFSE_MACHINE_ID = 'guid-planos';

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigo };')();

test('planos: teste 1 empresa e 2 clientes, planos pagos pelo código e limites', async () => {
  const { db, migrar } = await import('../src/db.js');
  migrar();
  const L = await import('../src/licenca.js');
  L._teste.agora = () => new Date('2026-03-10T15:00:00Z');
  const k = await ferr.gerarChaves();
  L._teste.chave = () => k.publica;
  db.prepare("INSERT INTO escritorios (id, nome) VALUES (1, 'E')").run();
  const emp = (n: number) => db.prepare("INSERT INTO empresas (escritorio_id, documento, razao_social, cod_municipio, op_simp_nac, ambiente) VALUES (1, ?, 'X', '4208203', 3, 2)").run(String(n).padStart(14, '0')).lastInsertRowid;
  const cli = (empresa: number, doc: string) => db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome) VALUES (?, 'CNPJ', ?, 'C')").run(empresa, doc);

  // teste: 7 dias, 1 empresa, 2 clientes
  let s = L.statusLicenca();
  assert.equal(s.plano, 'teste');
  assert.equal(s.diasRestantes, 7);
  assert.deepEqual(s.limites, { empresas: 1, clientes: 2 });
  L.exigirLimite('empresas');
  const e1 = Number(emp(1));
  assert.throws(() => L.exigirLimite('empresas'), /plano Teste permite 1 empresa/);
  L.exigirLimite('clientes', '111');
  cli(e1, '111');
  cli(e1, '222');
  assert.throws(() => L.exigirLimite('clientes', '333'), /permite 2 clientes/);
  L.exigirLimite('clientes', '111'); // cliente que já existe não conta de novo

  // bronze: 1 empresa, clientes sem limite
  let c = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'Cliente', 'bronze');
  assert.match(c, /^KG2\./);
  s = L.ativarLicenca(c);
  assert.equal(s.plano, 'bronze');
  assert.equal(s.planoNome, 'Bronze');
  L.exigirLimite('clientes', '333');
  assert.throws(() => L.exigirLimite('empresas'), /plano Bronze permite 1 empresa/);

  // prata: até 5 empresas
  c = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'Cliente', 'prata');
  s = L.ativarLicenca(c);
  assert.deepEqual(s.limites, { empresas: 5, clientes: null });
  for (const n of [2, 3, 4, 5]) { L.exigirLimite('empresas'); emp(n); }
  assert.throws(() => L.exigirLimite('empresas'), /permite 5 empresas/);

  // ouro: 15; diamante: sem limite
  c = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'Cliente', 'ouro');
  assert.equal(L.ativarLicenca(c).limites.empresas, 15);
  c = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'Cliente', 'diamante');
  s = L.ativarLicenca(c);
  assert.deepEqual(s.limites, { empresas: null, clientes: null });
  L.exigirLimite('empresas');

  // plano adulterado é recusado; código antigo (KG1) segue sem limite
  const [a, p, g] = c.split('.');
  const troca = [a, Buffer.from(Buffer.from(p, 'base64url').toString().replace('diamante', 'bronze')).toString('base64url'), g].join('.');
  assert.throws(() => L.ativarLicenca(troca), /inválido/);
  c = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'Antigo');
  assert.match(c, /^KG1\./);
  assert.deepEqual(L.ativarLicenca(c).limites, { empresas: null, clientes: null });
  await assert.rejects(ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-04-10', 'X', 'platina'), /Escolha o plano/);
});
