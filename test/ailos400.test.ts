import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gerarRemessa400, lerRetorno400 } from '../src/cobranca/ailos400.js';
import { lerRetornoAuto, nossoNumero } from '../src/cobranca/ailos.js';

// Dados fictícios, no formato dos arquivos reais do Ailos (conferido registro a registro contra uma remessa real).
const conta = { cooperativa_nome: 'AILOS', agencia: '0101', agencia_dv: '5', conta: '388785', conta_dv: '5', convenio: '10111', carteira: '01' };
const tit = (id: number, boleto: number, venc: string, valor: number, mov: 'ENTRADA' | 'BAIXA' = 'ENTRADA') => ({
  idInterno: id, nossoNumero: nossoNumero(conta, boleto), numeroDocumento: '', vencimento: venc, emissao: venc, valor, multaPct: 3, jurosPctMes: 1, mensagens: [], movimento: mov,
  pagador: { documento: '04.254.968/0001-03', nome: 'Fulano & Cia Ltda', endereco: 'RUA GERMANO KUHLMANN144', bairro: 'Badenfurdt', cep: '89070-840', cidade: 'Blumenau', uf: 'SC' },
});

test('remessa CNAB 400 Ailos: posições conferidas com arquivo real', () => {
  const txt = gerarRemessa400({ beneficiario: { documento: '13.269.205/0001-19', nome: 'Beneficiario Teste' }, conta, numeroRemessa: 266, agora: new Date('2026-10-05T15:00:00Z'), titulos: [tit(5191, 6505, '2026-10-15', 373.8), tit(5200, 6510, '2026-10-20', 405, 'BAIXA')] });
  const l = txt.split('\r\n').filter(Boolean);
  assert.deepEqual(l.map((x) => x.length), l.map(() => 400));
  assert.equal(l.length, 5); // header, detalhe+multa, detalhe (baixa, sem multa), trailer
  assert.equal(l[0].slice(0, 19), '01REMESSA01COBRANCA'); assert.equal(l[0].slice(26, 40), '01015003887855'); assert.equal(l[0].slice(76, 94).trim(), '085CECRED');
  assert.equal(l[0].slice(94, 107), '0510260000266'); assert.equal(l[0].slice(129, 136), '0010111'); assert.equal(l[0].slice(394), '000001');
  const d = l[1];
  assert.equal(d.slice(0, 17), '70213269205000119'); assert.equal(d.slice(17, 38), '010150038878550010111'); assert.equal(d.slice(38, 42), '5191');
  assert.equal(d.slice(63, 84), '038878550000065050000'); assert.equal(d.slice(108, 110), '01'); assert.equal(d.slice(120, 126), '151026'); assert.equal(d.slice(126, 139), '0000000037380');
  assert.equal(d.slice(139, 150), '0850000 01N'); assert.equal(d.slice(160, 173), '0000000000012'); assert.equal(d.slice(218, 234), '0204254968000103');
  assert.equal(d.slice(234, 274).trim(), 'FULANO & CIA LTDA'); assert.equal(d.slice(326, 334), '89070840'); assert.equal(d.slice(334, 349).trim(), 'BLUMENAU'); assert.equal(d.slice(349, 351), 'SC'); assert.equal(d.slice(394), '000002');
  assert.equal(l[2], '5991161026000000001121' + ' '.repeat(372) + '000003');
  assert.equal(l[3].slice(108, 110), '02'); assert.equal(l[3].slice(160, 173), '0000000000000'); assert.equal(l[3].slice(394), '000004');
  assert.equal(l[4], '9' + ' '.repeat(393) + '000005');
});

test('retorno CNAB 400 Ailos: liquidação', () => {
  const put = (a: string[], de: number, s: string) => { for (let i = 0; i < s.length; i++) a[de - 1 + i] = s[i]; };
  const h = Array(400).fill(' '); put(h, 1, '02RETORNO01COBRANCA'); put(h, 77, '085'); put(h, 95, '071026'); put(h, 101, '0001831'); put(h, 395, '000001');
  const d = Array(400).fill(' '); put(d, 1, '7'); put(d, 39, '5164'); put(d, 64, '03887855000006478'); put(d, 109, '06'); put(d, 111, '061026'); put(d, 147, '101026'); put(d, 153, '0000000058000'); put(d, 176, '071026'); put(d, 306, '0000000058000'); put(d, 395, '000002');
  const t = Array(400).fill(' '); put(t, 1, '9'); put(t, 395, '000003');
  const txt = [h, d, t].map((x) => x.join('')).join('\r\n');
  const r = lerRetornoAuto(txt);
  assert.equal(r.layout, 'CNAB400'); assert.equal(r.numeroRetorno, 1831);
  assert.deepEqual(r.itens.map((i) => [i.nossoNumero, i.movimento, i.valorPago, i.dataOcorrencia, i.dataCredito, i.vencimento, i.valorTitulo]), [['03887855000006478', '06', 580, '2026-10-06', '2026-10-07', '2026-10-10', 580]]);
  assert.throws(() => lerRetorno400(['01REMESSA' + ' '.repeat(391)]), /retorno/);
});
