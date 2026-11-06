import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('multa/juros por cliente e desconto por pontualidade: condições do boleto e campos da remessa', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-pont-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { condicoesDoBoleto } = await import('../src/servicos/cobranca.js');
  const conta = { multa_pct: 2, juros_pct_mes: 1 };
  // sem cadastro no cliente: vale a conta bancária
  assert.deepEqual(condicoesDoBoleto(conta, { valor: 1000, vencimento: '2026-11-10', emissao: '2026-10-25' }), { multa: 2, juros: 1, pontual: null });
  // cliente com multa 0 (isento) e 5% de desconto até 5 dias antes do vencimento
  const c = { valor: 1000, vencimento: '2026-11-10', emissao: '2026-10-25', multa_pct: 0, juros_pct_mes: 0.5, desc_pontual_pct: 5, desc_pontual_dias: 5 };
  assert.deepEqual(condicoesDoBoleto(conta, c), { multa: 0, juros: 0.5, pontual: { valor: 50, ate: '2026-11-05' } });
  // prazo do desconto já passou na emissão: sem desconto
  assert.equal(condicoesDoBoleto(conta, { ...c, emissao: '2026-11-08' }).pontual, null);
  // 0 dias = até o vencimento
  assert.equal(condicoesDoBoleto(conta, { ...c, desc_pontual_dias: 0 }).pontual?.ate, '2026-11-10');

  const { gerarRemessa } = await import('../src/cobranca/ailos.js');
  const { gerarRemessa400 } = await import('../src/cobranca/ailos400.js');
  const contaAilos: any = { agencia: '0101', agencia_dv: '5', conta: '123456', conta_dv: '7', convenio: '101002', carteira: '01', cooperativa_nome: 'Ailos' };
  const t = { idInterno: 1, nossoNumero: '10100200000000001', numeroDocumento: 'NF 1', vencimento: '2026-11-10', valor: 1000, emissao: '2026-10-25', multaPct: 0, jurosPctMes: 0.5, descontoPontual: { valor: 50, ate: '2026-11-05' },
    mensagens: [], movimento: 'ENTRADA' as const, pagador: { documento: '529.982.247-25', nome: 'Fulano', endereco: 'Rua A, 1', bairro: 'Centro', cep: '89010-000', cidade: 'Blumenau', uf: 'SC' } };
  const l240 = gerarRemessa({ beneficiario: { documento: '04.173.780/0001-22', nome: 'Empresa' }, conta: contaAilos, numeroRemessa: 1, agora: new Date('2026-10-25T15:00:00Z'), titulos: [t] }).split('\r\n');
  const p = l240[2];
  assert.equal(p[141], '1'); assert.equal(p.slice(142, 150), '05112026'); assert.equal(p.slice(150, 165), '000000000005000');
  const sem = gerarRemessa({ beneficiario: { documento: '04.173.780/0001-22', nome: 'Empresa' }, conta: contaAilos, numeroRemessa: 1, agora: new Date('2026-10-25T15:00:00Z'), titulos: [{ ...t, descontoPontual: null }] }).split('\r\n')[2];
  assert.equal(sem[141], '0'); assert.equal(sem.slice(150, 165), '000000000000000');
  const l400 = gerarRemessa400({ beneficiario: { documento: '13.269.205/0001-19', nome: 'Benef' }, conta: { ...contaAilos, convenio: '10111', conta: '388785', conta_dv: '5' }, numeroRemessa: 1, agora: new Date('2026-10-25T15:00:00Z'), titulos: [t] }).split('\r\n');
  assert.equal(l400[1].length, 400); assert.equal(l400[1].slice(173, 179), '051126'); assert.equal(l400[1].slice(179, 192), '0000000005000');
});
