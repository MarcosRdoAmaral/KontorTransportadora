import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lic-')), 'a.db');
process.env.MASTER_KEY ??= 'a'.repeat(64);
process.env.SESSION_SECRET ??= 'b'.repeat(32);
process.env.KONTOR_MARCAS = fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-')); // marcas do teste fora do banco
process.env.NFSE_MACHINE_ID = 'guid-do-computador-de-teste';

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigo, somaMeses, lerChavePrivada };')();

test('licença: teste de 7 dias, ativação por computador, vencimento e relógio', async () => {
  (await import('../src/db.js')).migrar();
  const L = await import('../src/licenca.js');
  const { calcularVencimento, valorLiquido } = await import('../src/servicos/faturamento.js');
  let agora = new Date('2026-01-10T15:00:00Z');
  L._teste.agora = () => agora;

  // sem chave: modo livre
  L._teste.chave = () => '';
  assert.equal(L.statusLicenca().estado, 'livre');
  L.exigirLicenca();

  const k = await ferr.gerarChaves();
  L._teste.chave = () => k.publica;
  assert.equal(L.statusLicenca().estado, 'teste');
  assert.equal(L.statusLicenca().diasRestantes, 7);
  agora = new Date('2026-01-14T15:00:00Z');
  assert.equal(L.statusLicenca().estado, 'teste');
  assert.equal(L.statusLicenca().diasRestantes, 3);
  agora = new Date('2026-01-20T15:00:00Z');
  assert.equal(L.statusLicenca().estado, 'vencida');
  assert.throws(() => L.exigirLicenca(), /teste terminou/);

  // código de outro computador é recusado
  const outro = await ferr.emitirCodigo(k.privada, 'AAAA-BBBB-CCCC-DDDD', '2026-05-20', 'Cliente X');
  assert.throws(() => L.ativarLicenca(outro), /outro computador/);
  // adulterado é recusado
  const bom = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-05-20', 'Cliente X');
  const [a, p, s] = bom.split('.');
  const adulterado = [a, Buffer.from(Buffer.from(p, 'base64url').toString().replace('2026-05-20', '2030-05-20')).toString('base64url'), s].join('.');
  assert.throws(() => L.ativarLicenca(adulterado), /inválido/);
  // chave de outro dono é recusada
  const k2 = await ferr.gerarChaves();
  const forjado = await ferr.emitirCodigo(k2.privada, L.codigoDoComputador(), '2026-05-20', 'Falso');
  assert.throws(() => L.ativarLicenca(forjado), /inválido/);

  const st = L.ativarLicenca(bom);
  assert.equal(st.estado, 'ativa');
  assert.equal(st.diasRestantes, 120);
  L.exigirLicenca();
  agora = new Date('2026-05-10T15:00:00Z');
  assert.equal(L.statusLicenca().aviso, true);
  agora = new Date('2026-05-21T15:00:00Z');
  assert.equal(L.statusLicenca().estado, 'vencida');
  // renovar
  const renovado = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-08-20', 'Cliente X');
  assert.equal(L.ativarLicenca(renovado).estado, 'ativa');
  // relógio voltado
  agora = new Date('2026-03-01T15:00:00Z');
  assert.equal(L.statusLicenca().estado, 'relogio');

  // vencimento e valor líquido
  assert.equal(calcularVencimento(new Date('2026-01-10T12:00:00Z'), 'PRAZO', 10), '2026-01-20');
  assert.equal(calcularVencimento(new Date('2026-01-10T12:00:00Z'), 'DIA_FIXO', 15), '2026-01-15');
  assert.equal(calcularVencimento(new Date('2026-01-20T12:00:00Z'), 'DIA_FIXO', 15), '2026-02-15');
  assert.equal(calcularVencimento(new Date('2026-01-31T12:00:00Z'), 'DIA_FIXO', 31), '2026-02-28');
  assert.equal(valorLiquido({ valor: 1000, aliquota: 2, issRetido: 2, retencoes: { irrf: 15 } } as any), 965);
});


test('gerador de licenças aceita a chave privada em vários formatos', async () => {
  const k = await ferr.gerarChaves();
  const { d, x } = JSON.parse(k.privada);
  const base = await ferr.emitirCodigo(k.privada, 'AAAA-BBBB-CCCC-DDDD', '2027-01-01', 'Cliente');
  assert.match(base, /^KG1\./);
  const aspasTrocadas = k.privada.replace(/"/g, '\u201C').replace(/\u201C:/, '":');
  for (const forma of [`  ${k.privada}\n`, aspasTrocadas, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x, d }), `"d":"${d}","x":"${x}"`]) {
    const c = await ferr.emitirCodigo(forma, 'AAAA-BBBB-CCCC-DDDD', '2027-01-01', 'Cliente');
    assert.equal(c, base, 'Ed25519 é determinístico: mesma chave, mesmo código');
  }
  // chave com só o "d": a pública esperada é a do aplicativo, que não é a deste par → recusa com mensagem clara
  await assert.rejects(ferr.emitirCodigo(d, 'AAAA-BBBB-CCCC-DDDD', '2027-01-01', 'Cliente'), /não corresponde/);
  await assert.rejects(ferr.emitirCodigo('{ quebrado', 'AAAA-BBBB-CCCC-DDDD', '2027-01-01', 'Cliente'), /JSON|formato/);
  await assert.rejects(ferr.emitirCodigo('', 'AAAA-BBBB-CCCC-DDDD', '2027-01-01', 'Cliente'), /Cole a chave/);
});
