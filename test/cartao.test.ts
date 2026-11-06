import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

/** PDF sintético no desenho da fatura Ailos Cartões: Data | Descrição | Crédito R$ | Débito R$ (alinhados à direita). */
function pdfFatura(): Promise<Buffer> {
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const partes: Buffer[] = []; doc.on('data', (b) => partes.push(b)); doc.on('end', () => ok(Buffer.concat(partes)));
    doc.fontSize(8);
    const t = (s: string, x: number, y: number) => doc.text(s, x, y, { lineBreak: false });
    const dir = (s: string, fim: number, y: number) => doc.text(s, fim - 80, y, { width: 80, align: 'right', lineBreak: false });
    t('FATURA DE AGOSTO - VENCIMENTO: 19/08/2026', 150, 30);
    t('MARIA TESTE - Emissão 10/08/2026', 150, 42); t('Conta Cartão: 1234567890', 150, 54);
    t('Despesas / Débito: 252,00', 40, 66); t('Encargos: 13,50', 40, 78); t('Pagamento / Crédito: 100,00', 40, 90);
    t('Pagamento mínimo', 40, 102); t('Total da fatura', 200, 102); t('40,00', 40, 114); t('265,50', 200, 114);
    t('Movimentação', 40, 130);
    t('Data', 20, 142); t('Descrição', 80, 142); t('Crédito R$', 340, 142); t('Débito R$', 410, 142);
    t('SALDO ANTERIOR', 80, 154); dir('100,00', 443, 154);
    t('09/07', 20, 166); t('ANUIDADE MASTERCARD (0021)', 80, 166); dir('13,50', 443, 166);
    t('09/07', 20, 178); t('DESC ANUIDADE POR USO', 80, 178); dir('13,50', 375, 178);
    t('20/07', 20, 190); t('PAGTO DEB EM CONTA - C', 80, 190); dir('100,00', 375, 190);
    t('GASTOS DE MARIA TESTE (6156)', 20, 210);
    t('19/09', 20, 222); t('MP *MARMORES 11/12 OSASCO', 80, 222); dir('200,00', 443, 222);
    t('07/08', 20, 234); t('PAPELARIA CENTRAL', 80, 234); dir('52,00', 443, 234);
    t('TOTAL', 20, 250); dir('252,00', 443, 250);
    doc.end();
  });
}

test('fatura de cartão: leitura do PDF, importação, classificação e espelho em despesas', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-car-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { lerPdfFatura } = await import('../src/servicos/cartao.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const pdf = await pdfFatura();
    const lida = await lerPdfFatura(pdf);
    assert.equal(lida.vencimento, '2026-08-19');
    assert.equal(lida.totalFatura, 265.5); assert.equal(lida.pagamentoMinimo, 40);
    assert.deepEqual(lida.avisos, []);
    const compras = lida.itens.filter((i) => i.tipo === 'COMPRA');
    assert.deepEqual(compras.map((c) => c.valor), [200, 52]);
    assert.equal(compras[0].descricao, 'MP *MARMORES'); assert.equal(compras[0].parcelaAtual, 11); assert.equal(compras[0].cidade, 'OSASCO');
    assert.equal(compras[0].data, '2025-09-19'); assert.equal(compras[0].cartaoFinal, '6156');
    assert.equal(lida.itens.find((i) => i.tipo === 'PAGAMENTO')?.valor, -100);
    await assert.rejects(lerPdfFatura(Buffer.from('%PDF-1.4 lixo')), /PDF/);

    const token = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const emp = (await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, token)).json.id;
    const url = `/api/empresas/${emp}/cartao`;
    const imp = await call('POST', `${url}/importar`, { nome: 'f.pdf', pdfBase64: pdf.toString('base64') }, token);
    assert.equal(imp.status, 200, JSON.stringify(imp.json));
    assert.equal(imp.json.novos, 5); assert.equal(imp.json.vencimento, '2026-08-19');
    assert.equal((await call('POST', `${url}/importar`, { nome: 'f.pdf', pdfBase64: pdf.toString('base64') }, token)).status, 400);

    // anuidade cancelada pelo desconto: nada vira despesa até classificar; compras sem categoria também não
    assert.equal((db.prepare("SELECT COUNT(*) n FROM despesas WHERE origem = 'CARTAO'").get() as any).n, 0);
    const mes = (await call('GET', `${url}?mes=2026-08`, undefined, token)).json;
    assert.equal(mes.totalGastos, 265.5); assert.equal(mes.semClassificacao, 2);
    const marm = mes.lancamentos.find((l: any) => l.descricao === 'MP *MARMORES');
    assert.equal((await call('PUT', `${url}/${marm.id}`, { categoria: 'Material', aplicarSemelhantes: true }, token)).status, 200);
    const d = db.prepare("SELECT * FROM despesas WHERE origem = 'CARTAO'").all() as any[];
    assert.equal(d.length, 1); assert.equal(d[0].valor, 200); assert.equal(d[0].forma_pagamento, 'CREDITO'); assert.equal(d[0].data, '2026-08-19'); assert.equal(d[0].categoria, 'Material');
    // espelho é somente leitura
    const ed = await call('PUT', `/api/empresas/${emp}/despesas/${d[0].id}`, { data: '2026-08-19', categoria: 'X', valor: 1 }, token);
    assert.equal(ed.status, 400);
    // excluir a fatura remove as despesas
    const fid = mes.faturas[0].id;
    assert.equal((await call('DELETE', `${url}/faturas/${fid}`, undefined, token)).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM despesas WHERE origem = 'CARTAO'").get() as any).n, 0);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
