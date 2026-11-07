import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { gerarDemonstrativoPdf } from '../src/cobranca/demonstrativo-pdf.js';
import { montarPix } from '../src/cobranca/pix.js';

test('demonstrativo: o Pix copia e cola sai numa linha só, sem quebras, para colar no banco', async () => {
  const pix = montarPix({ chave: '3d15321c-e006-4af5-84eb-d0303dcc37c5', valor: 295, nome: 'CICLO ASSESSORIA CONTABIL', cidade: 'BLUMENAU', txid: 'KONTOR8' });
  const pdf = await gerarDemonstrativoPdf({ emitente: { nome: 'Ciclo', documento: '13269205000119', endereco: 'Rua X', contato: '' }, cliente: { nome: 'Cliente', documento: '69271084000102', endereco: 'Rua Y' },
    referencia: '10/2026', vencimento: '2026-11-10', itens: [{ descricao: 'Serviços', qtd: 1, valor: 295 }], total: 295, pix });
  // junta o texto dos fluxos de conteúdo do PDF e procura o código inteiro num único comando de texto
  const bin = pdf.toString('latin1');
  const fluxos = [...bin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => { try { return zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { return ''; } }).join('\n');
  const hex = Buffer.from(pix, 'latin1').toString('hex');
  const linhas = fluxos.split('\n').filter((l) => /\] TJ|Tj/.test(l));
  const comCodigo = linhas.filter((l) => l.replace(/[^0-9a-f]/gi, '').toLowerCase().includes(hex.slice(0, 40)));
  assert.equal(comCodigo.length, 1, 'o código aparece numa única linha de texto');
});
