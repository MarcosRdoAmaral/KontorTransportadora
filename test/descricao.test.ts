import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DescricaoModelo, EntradaDescricao, lerModelo, montarDescricao } from '../src/servicos/descricao.js';

test('descrição composta: período, ordem de compra, linhas e INSS só sobre a mão de obra', () => {
  const m = DescricaoModelo.parse({ texto: 'Prestação de serviços conforme contrato', linhas: [{ rotulo: 'Mão de obra', retem_cp: true }, { rotulo: 'Aluguel de máquinas' }] });
  assert.equal(m.cp_pct, 11);
  const r = montarDescricao(m, EntradaDescricao.parse({ periodoIni: '2026-10-01', periodoFim: '2026-10-31', ordemCompra: 'OC-123', valores: [10000, 5000] }));
  assert.equal(r.valorTotal, 15000);
  assert.equal(r.baseCp, 10000);
  assert.equal(r.cp, 1100);
  const linhas = r.descricao.split('\n');
  assert.equal(linhas[0], 'Prestação de serviços conforme contrato');
  assert.equal(linhas[1], 'Período: 01/10/2026 a 31/10/2026');
  assert.equal(linhas[2], 'Ordem de compra: OC-123');
  assert.match(linhas[3], /^Mão de obra: R\$\s10\.000,00$/);
  assert.match(linhas[4], /^Aluguel de máquinas: R\$\s5\.000,00$/);
  // linha zerada não aparece; período invertido recusa
  assert.equal(montarDescricao(m, EntradaDescricao.parse({ valores: [0, 800] })).descricao.includes('Mão de obra'), false);
  assert.throws(() => montarDescricao(m, EntradaDescricao.parse({ periodoIni: '2026-10-31', periodoFim: '2026-10-01', valores: [1, 1] })), /anterior/);
  assert.equal(lerModelo(JSON.stringify({ ...m, ativo: false })), null);
  assert.equal(lerModelo('lixo'), null);
});
