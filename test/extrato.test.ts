import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

/** PDF sintético com o mesmo desenho do extrato de conta corrente do Ailos (colunas alinhadas à direita). */
function pdfExtrato(linhas: string[][], saldoAnt: string, total: string[]): Promise<Buffer> {
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const partes: Buffer[] = []; doc.on('data', (b) => partes.push(b)); doc.on('end', () => ok(Buffer.concat(partes)));
    doc.fontSize(8);
    const t = (s: string, x: number, y: number) => doc.text(s, x, y, { lineBreak: false });
    const dir = (s: string, fim: number, y: number) => doc.text(s, fim - 90, y, { width: 90, align: 'right', lineBreak: false });
    t('EXTRATO', 250, 40); t('Período 01/09/2025 a 30/09/2025', 200, 55);
    t('Nome: EMPRESA TESTE LTDA', 214, 70); t('Cooperativa: VIACREDI | Banco: 085 | Agência: 0101-5 | Conta: 1234567', 160, 85);
    t('DATA', 20, 110); t('DESCRIÇÃO', 75, 110); dir('DOCUMENTO', 350, 110); t('CRÉDITO', 369, 110); t('(R$)', 407.8, 110); t('DÉBITO', 452, 110); t('(R$)', 485.8, 110); dir('SALDO (R$)', 580, 110);
    t('SALDO ANTERIOR', 75, 130); dir(saldoAnt, 579, 130);
    let y = 150;
    for (const [data, desc, docu, cred, deb, saldo] of linhas) {
      t(data, 20, y); t(desc, 75, y); if (docu) dir(docu, 348, y + 0.2); if (cred) dir(cred, 426, y + 0.2); if (deb) dir(deb, 504, y + 0.2); dir(saldo, 579, y + 0.2);
      y += 15;
    }
    t('TOTAL', 20, y + 10); dir(total[0], 426, y + 10); dir(total[1], 504, y + 10); dir(total[2], 579, y + 10);
    doc.end();
  });
}

test('extrato Ailos: leitura do PDF, importação, classificação e conciliação com boletos', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-ext-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { lerPdfExtrato } = await import('../src/servicos/extrato.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const linhas = [
      ['02/09/2025', 'CRED.COBR.CE', '10.120', '500,00', '', '1.500,00'],
      ['03/09/2025', 'IOF S/ C-C', '355.174', '', '-20,50', '1.479,50'],
      ['05/09/2025', 'FOLHA DE PAGT', '2.900', '', '-300,00', '1.179,50'],
      ['05/09/2025', 'DEBITO PIX - FULANO DE TAL', '685091.344', '', '-100,00', '1.079,50'],
      ['06/09/2025', 'DEBITO PIX - FULANO DE TAL', '685092.111', '', '-50,00', '1.029,50'],
    ];
    const pdf = await pdfExtrato(linhas, '1.000,00', ['500,00', '-470,50', '1.029,50']);
    const lido = await lerPdfExtrato(pdf);
    assert.equal(lido.lancamentos.length, 5);
    assert.deepEqual(lido.lancamentos.map((l) => l.valor), [500, -20.5, -300, -100, -50]);
    assert.equal(lido.lancamentos[3].descricao, 'DEBITO PIX - FULANO DE TAL'); assert.equal(lido.lancamentos[3].documento, '685091.344');
    assert.equal(lido.periodoIni, '2025-09-01'); assert.equal(lido.conta, '1234567'); assert.deepEqual(lido.avisos, []);
    // total do banco diferente do lido → aviso
    const ruim = await lerPdfExtrato(await pdfExtrato(linhas, '1.000,00', ['999,00', '-470,50', '1.029,50']));
    assert.ok(ruim.avisos.some((a) => /diferem do total/.test(a)));
    await assert.rejects(lerPdfExtrato(Buffer.from('%PDF-1.4 lixo')), /PDF/);

    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, t)).json.id;
    const tid = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, modo_faturamento) VALUES (?,?,?,?,'NOTA_BOLETO')").run(eid, 'CPF', '52998224725', 'Cliente Pagador').lastInsertRowid);
    const cob = Number(db.prepare("INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status) VALUES (?,?,?,?,?,'REGISTRADO')").run(eid, tid, 'Honorários', 500, '2025-09-02').lastInsertRowid);

    const imp = await call('POST', `/api/empresas/${eid}/extrato/importar`, { nome: 'extrato.pdf', pdfBase64: pdf.toString('base64') }, t);
    assert.equal(imp.status, 200, JSON.stringify(imp.json));
    assert.equal(imp.json.novos, 5); assert.equal(imp.json.conciliados, 1, 'único boleto de R$ 500 em aberto perto da data');
    assert.equal((await call('POST', `/api/empresas/${eid}/extrato/importar`, { nome: 'extrato.pdf', pdfBase64: pdf.toString('base64') }, t)).status, 400, 'mesmo arquivo');

    const m = (await call('GET', `/api/empresas/${eid}/extrato?mes=2025-09`, undefined, t)).json;
    const por = (d: string) => m.lancamentos.find((l: any) => l.descricao.startsWith(d));
    assert.equal(por('CRED.COBR').categoria, 'Receita de serviços'); assert.ok(por('CRED.COBR').cobranca_id);
    assert.equal(por('IOF').categoria, 'Tarifas e juros'); assert.equal(por('FOLHA').categoria, 'Salários e encargos');
    assert.equal(m.semClassificacao, 2); assert.equal(m.entradas, 500); assert.equal(m.saidas, 470.5);

    // classificar um PIX aplica ao parecido e lembra para as próximas importações
    const pix = m.lancamentos.filter((l: any) => l.descricao.startsWith('DEBITO PIX'));
    assert.equal((await call('PUT', `/api/empresas/${eid}/extrato/${pix[0].id}`, { categoria: 'Fornecedores', aplicarSemelhantes: true }, t)).status, 200);
    const m2 = (await call('GET', `/api/empresas/${eid}/extrato?mes=2025-09`, undefined, t)).json;
    assert.equal(m2.semClassificacao, 0);
    const bal = (await call('GET', `/api/empresas/${eid}/extrato/balanco?de=2025-09-01&ate=2025-09-30`, undefined, t)).json;
    assert.equal(bal.resultado, 29.5); assert.equal(bal.saidas.find((x: any) => x.categoria === 'Fornecedores').total, 150);

    // saídas classificadas viram despesas espelho (balanço), com a forma de pagamento deduzida
    const desp = db.prepare("SELECT categoria, valor, forma_pagamento, origem FROM despesas WHERE empresa_id = ? ORDER BY valor").all(eid) as any[];
    assert.equal(desp.length, 4); assert.ok(desp.every((x) => x.origem === 'EXTRATO'));
    assert.deepEqual(desp.map((x) => x.valor), [20.5, 50, 100, 300]);
    assert.equal(desp.find((x) => x.valor === 100).forma_pagamento, 'PIX');
    assert.equal(desp.find((x) => x.valor === 100).categoria, 'Fornecedores');
    // espelho não se edita pelas despesas
    const idEsp = (db.prepare("SELECT id FROM despesas WHERE empresa_id = ? AND valor = 100").get(eid) as any).id;
    assert.equal((await call('PUT', `/api/empresas/${eid}/despesas/${idEsp}`, { data: '2025-09-05', categoria: 'Outras', valor: 100 }, t)).status, 400);
    // reclassificar como transferência tira da despesa
    assert.equal((await call('PUT', `/api/empresas/${eid}/extrato/${pix[0].id}`, { categoria: 'Transferências', aplicarSemelhantes: true }, t)).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM despesas WHERE empresa_id = ?").get(eid) as any).n, 2);
    assert.equal((await call('PUT', `/api/empresas/${eid}/extrato/${pix[0].id}`, { categoria: 'Fornecedores', aplicarSemelhantes: true }, t)).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM despesas WHERE empresa_id = ?").get(eid) as any).n, 4);

    // baixa do boleto ao ligar: desfaz e liga de novo dando baixa
    assert.equal((await call('POST', `/api/empresas/${eid}/extrato/${por('CRED.COBR').id}/conciliar`, { cobrancaId: null }, t)).status, 200);
    assert.equal((await call('POST', `/api/empresas/${eid}/extrato/${por('CRED.COBR').id}/conciliar`, { cobrancaId: cob, darBaixa: true }, t)).status, 200);
    assert.equal((db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(cob) as any).status, 'PAGO');
    assert.equal((await call('POST', `/api/empresas/${eid}/extrato/${pix[0].id}/conciliar`, { cobrancaId: cob }, t)).status, 400, 'saída não liga a boleto');

    // OFX passa a usar o extrato importado
    const { gerarOfx } = await import('../src/servicos/contabilidade.js');
    const ofx = gerarOfx(eid, '2025-09-01', '2025-09-30');
    assert.match(ofx, /KG-EXT-/); assert.match(ofx, /<TRNAMT>-20.50/); assert.match(ofx, /\[Fornecedores\]/);

    // permissões: usuário sem o módulo "despesas" não acessa
    assert.equal((await call('GET', `/api/empresas/${eid}/extrato`, undefined, undefined)).status, 401);
    assert.equal((await call('DELETE', `/api/empresas/${eid}/extrato/importacoes/${imp.json.importacaoId}`, undefined, t)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${eid}/extrato?mes=2025-09`, undefined, t)).json.lancamentos.length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM despesas WHERE empresa_id = ?').get(eid) as any).n, 0, 'excluir a importação remove as despesas espelho');
  } finally { await app.close(); }
});
