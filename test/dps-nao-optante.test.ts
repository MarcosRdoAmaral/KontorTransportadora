import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarDps } from '../src/nfse/dps.js';

const base: any = {
  tpAmb: 2, dhEmi: '2026-10-23T10:00:00-03:00', verAplic: 't', serie: '1', nDPS: 1, dCompet: '2026-10-23', cLocEmi: '4202404',
  prestador: { documento: '10512356000168', opSimpNac: 1, regEspTrib: 0 },
  servico: { cLocPrestacao: '4202404', cTribNac: '071002', xDescServ: 'x', cNBS: '118031000' },
  valores: { vServ: 100, tribISSQN: 1, tpRetISSQN: 1 },
};

test('não optante: sem indTotTrib/pTotTribSN/pAliq; com pTotTrib', () => {
  const { xml } = montarDps(base);
  assert.match(xml, /<totTrib><pTotTrib><pTotTribFed>0\.00<\/pTotTribFed><pTotTribEst>0\.00<\/pTotTribEst><pTotTribMun>0\.00<\/pTotTribMun><\/pTotTrib><\/totTrib>/);
  assert.ok(!xml.includes('indTotTrib') && !xml.includes('pTotTribSN') && !xml.includes('<pAliq>'));
});

test('MEI continua com indTotTrib=0', () => {
  const { xml } = montarDps({ ...base, prestador: { ...base.prestador, opSimpNac: 2 } });
  assert.match(xml, /<totTrib><indTotTrib>0<\/indTotTrib><\/totTrib>/);
});
