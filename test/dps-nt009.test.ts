import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { montarDps, leiauteVigente } from '../src/nfse/dps.js';

// Valida a DPS (sem assinatura: a Signature é opcional no XSD da DPS) contra o XSD de cada leiaute.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt009-'));
const xsd004 = path.join(tmp, 'xsd004');
fs.cpSync(path.resolve('schemas/1.01'), xsd004, { recursive: true });
const ts = path.join(xsd004, 'tiposSimples_v1.01.xsd');
fs.writeFileSync(ts, fs.readFileSync(ts, 'utf8').replace('^0{0,4}\\d{1,5}$', '0{0,4}\\d{1,5}')); // mesmo ajuste do e2e
const xsd009 = path.resolve('schemas/nt009-r1');

function validar(xml: string, dir: string) {
  const f = path.join(tmp, `dps-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>${xml}`);
  try { execSync(`xmllint --noout --schema ${dir}/DPS_v1.01.xsd ${f} 2>&1`); }
  catch (e: any) { assert.fail(`XSD (${path.basename(dir)}): ${e.stdout?.toString()}`); }
}

const base: any = {
  tpAmb: 2, dhEmi: '2026-10-26T09:00:00-03:00', verAplic: 'kontor-teste', serie: '1', nDPS: 7, dCompet: '2026-10-26', cLocEmi: '4202404',
  prestador: { documento: '10512356000168', opSimpNac: 1, regEspTrib: 0 },
  tomador: { documento: '11222333000181', nome: 'Cliente Teste Ltda' },
  servico: { cLocPrestacao: '4202404', cTribNac: '171901', xDescServ: 'Serviços de contabilidade', cNBS: '118031000' },
  valores: { vServ: 1500, tribISSQN: 1, tpRetISSQN: 1 },
  ibscbs: {
    indFinal: 0, cIndOp: '100301', indDest: 0, cst: '000', cClassTrib: '000001',
  },
};

test('leiaute vigente: produção restrita já na NT 009; produção só a partir de 01/12/2026', () => {
  assert.equal(leiauteVigente(2, '2026-10-26T09:00:00-03:00'), 'nt009');
  assert.equal(leiauteVigente(1, '2026-11-30T23:59:00-03:00'), 'nt004');
  assert.equal(leiauteVigente(1, '2026-12-01T00:00:00-03:00'), 'nt009');
});

test('NT 009: valida no XSD de produção restrita de 20/10/2026', () => {
  const { xml, leiaute } = montarDps(base);
  assert.equal(leiaute, 'nt009');
  assert.match(xml, /<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe><cLocEmi>/);
  assert.match(xml, /<cNBS>118031000<\/cNBS><xDescServ>/);
  assert.match(xml, /<valores><trib><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/trib><\/valores><\/IBSCBS>/);
  assert.ok(!xml.includes('gReeRepRes') && !xml.includes('vAjusteBC') && !xml.includes('<gIBSCBS>'));
  validar(xml, xsd009);
});

test('NT 009 sem grupo IBS/CBS também valida (finNFSe = 0)', () => {
  const { xml } = montarDps({ ...base, ibscbs: undefined });
  assert.match(xml, /<finNFSe>0<\/finNFSe>/);
  validar(xml, xsd009);
});

test('NT 004 (produção até 30/11/2026) continua igual e valida no XSD 1.01', () => {
  const { xml, leiaute } = montarDps({ ...base, tpAmb: 1, dhEmi: '2026-11-30T10:00:00-03:00' });
  assert.equal(leiaute, 'nt004');
  assert.match(xml, /<IBSCBS><finNFSe>0<\/finNFSe>/);
  assert.match(xml, /<gIBSCBS><CST>000<\/CST>/);
  validar(xml, xsd004);
});
