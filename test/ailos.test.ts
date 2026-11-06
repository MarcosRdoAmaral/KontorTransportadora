import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barrasItf, codigoBarras, fatorVencimento, gerarRemessa, lerRetorno, linhaDigitavel, nossoNumero, num } from '../src/cobranca/ailos.js';

// Exemplo da Figura 1 do manual Ailos: convênio 101002, conta 903306-8, boleto nº 2, carteira 01, R$ 100,00, venc. 15/04/2021
const conta = { cooperativa_nome: 'AILOS', agencia: '101', agencia_dv: '5', conta: '903306', conta_dv: '8', convenio: '101002', carteira: '01' };

test('boleto: nosso número, fator, código de barras e linha digitável conferem com o manual', () => {
  assert.equal(nossoNumero(conta, 2), '09033068000000002');
  assert.equal(nossoNumero({ conta: '220665', conta_dv: '8' }, 254), '02206658000000254'); // exemplo do campo G069
  assert.equal(fatorVencimento('2021-04-15'), '8591');
  assert.equal(fatorVencimento('2000-07-03'), '1000');
  assert.equal(fatorVencimento('2025-02-21'), '9999');
  assert.equal(fatorVencimento('2025-02-22'), '1000');
  const barras = codigoBarras(conta, 2, '2021-04-15', 100);
  assert.equal(barras.length, 44);
  assert.equal(linhaDigitavel(barras), '08591.01008 20903.306809 00000.002014 9 85910000010000');
});

test('código de barras ITF: 44 dígitos ocupam 405 módulos', () => {
  const b = barrasItf(codigoBarras(conta, 2, '2021-04-15', 100));
  assert.equal(b.reduce((a, n) => a + n, 0), 405);
});

const titulo = (id: number, mov: 'ENTRADA' | 'BAIXA' = 'ENTRADA') => ({
  idInterno: id, nossoNumero: nossoNumero(conta, id), numeroDocumento: `NF 100${id}`, vencimento: '2026-11-10', valor: 985.5, emissao: '2026-10-23',
  multaPct: 2, jurosPctMes: 1, mensagens: ['APOS VENCIMENTO COBRAR 1% JUROS AO MES', 'E MULTA DE 2%'], movimento: mov,
  pagador: { documento: '529.982.247-25', nome: 'João da Silva Júnior', endereco: 'Rua das Flores, 10', bairro: 'Centro', cep: '89010-000', cidade: 'Blumenau', uf: 'SC' },
});

test('remessa CNAB 240: todas as linhas têm 240 posições e os campos principais estão nas posições do manual', () => {
  const txt = gerarRemessa({ beneficiario: { documento: '04.173.780/0001-22', nome: 'Empresa Teste Ltda' }, conta, numeroRemessa: 7, agora: new Date('2026-10-24T02:30:00Z'), titulos: [titulo(1), titulo(2, 'BAIXA')] });
  const l = txt.split('\r\n').filter(Boolean);
  assert.deepEqual(l.map((x) => x.length), l.map(() => 240));
  assert.deepEqual(l.map((x) => x[7]), ['0', '1', '3', '3', '3', '3', '3', '5', '9']); // header, header lote, P Q R (entrada), P Q (baixa), trailers
  assert.deepEqual(l.map((x) => x[13]).slice(2, 7), ['P', 'Q', 'R', 'P', 'Q']);
  assert.equal(l.length, 9);
  const h = l[0];
  assert.equal(h.slice(0, 3), '085'); assert.equal(h[142], '1'); assert.equal(h.slice(143, 151), '23102026'); assert.equal(h.slice(157, 163), '000007'); assert.equal(h.slice(163, 166), '087');
  assert.equal(h.slice(18, 32), '04173780000122'); assert.equal(h[17], '2');
  const p = l[2];
  assert.equal(p.slice(8, 13), '00001'); assert.equal(p[13], 'P'); assert.equal(p.slice(15, 17), '01');
  assert.equal(p.slice(37, 57), '09033068000000001   '); assert.equal(p.slice(77, 85), '10112026');
  assert.equal(p.slice(85, 100), '000000000098550'); assert.equal(p[60], '2'); assert.equal(p.slice(106, 108), '04');
  assert.equal(p[220], '3'); assert.equal(p[223], '2'); assert.equal(p.slice(227, 229), '09');
  const q = l[3];
  assert.equal(q[17], '1'); assert.equal(q.slice(18, 33), '000052998224725'); assert.equal(q.slice(33, 73).trim(), 'JOAO DA SILVA JUNIOR');
  assert.equal(q.slice(128, 133), '89010'); assert.equal(q.slice(133, 136), '000'); assert.equal(q.slice(136, 151).trim(), 'BLUMENAU'); assert.equal(q.slice(151, 153), 'SC');
  const r = l[4];
  assert.equal(r[13], 'R'); assert.equal(r[65], '2'); assert.equal(r.slice(66, 74), '11112026'); assert.equal(r.slice(74, 89), '000000000000200');
  assert.equal(l[2].slice(15, 17), '01'); assert.equal(l[5].slice(15, 17), '02');
  const tl = l[7];
  assert.equal(tl[7], '5'); assert.equal(tl.slice(17, 23), '000007'); assert.equal(tl.slice(23, 29), '000001'); assert.equal(tl.slice(29, 46), '00000000000098550');
  const ta = l[8];
  assert.equal(ta[7], '9'); assert.equal(ta.slice(17, 23), '000001'); assert.equal(ta.slice(23, 29), '000009');
});

test('retorno CNAB 240: lê segmentos T e U (liquidação e rejeição)', () => {
  const reg = (pos: Record<number, string>, seg: string) => {
    const a = Array(240).fill(' ');
    const put = (de: number, s: string) => { for (let i = 0; i < s.length; i++) a[de - 1 + i] = s[i]; };
    put(1, '085'); put(4, '0001'); put(8, '3'); put(14, seg);
    for (const k of Object.keys(pos)) put(Number(k), pos[Number(k)]);
    return a.join('');
  };
  const header = (() => { const a = Array(240).fill(' '); const put = (de: number, s: string) => { for (let i = 0; i < s.length; i++) a[de - 1 + i] = s[i]; }; put(1, '085'); put(4, '0000'); put(8, '0'); put(143, '2'); put(158, '000012'); return a.join(''); })();
  const T1 = reg({ 16: '06', 38: '09033068000000001', 59: 'NF 1001', 74: '10112026', 82: '000000000098550', 106: 'KG1', 214: '          ' }, 'T');
  const U1 = reg({ 16: '06', 18: '000000000000300', 78: '000000000098850', 93: '000000000098850', 138: '09112026', 146: '10112026' }, 'U');
  const T2 = reg({ 16: '03', 38: '09033068000000002', 74: '10112026', 82: '000000000098550', 214: '16' + '  ' + '08' + '      ' }, 'T');
  const U2 = reg({ 16: '03' }, 'U');
  const r = lerRetorno([header, T1, U1, T2, U2].join('\r\n'));
  assert.equal(r.numeroRetorno, 12);
  assert.equal(r.itens.length, 2);
  assert.deepEqual([r.itens[0].nossoNumero, r.itens[0].movimento, r.itens[0].valorPago, r.itens[0].dataCredito, r.itens[0].vencimento], ['09033068000000001', '06', 988.5, '2026-11-10', '2026-11-10']);
  assert.deepEqual([r.itens[1].movimento, r.itens[1].motivos], ['03', ['16', '08']]);
  assert.throws(() => lerRetorno('x'.repeat(100)), /240/);
});
void num;
