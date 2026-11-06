import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compras-'));
process.env.DATABASE_PATH = path.join(dir, 'd.db');
process.env.STORAGE_DIR = dir;
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = 'x';
process.env.NFSE_DESKTOP = '1';

const chave = '35261012345678000195550010000012341000012345';
const nfe = (extra = '', ch = chave, destino = '10512356000168') => `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>2026-10-10T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>12345678000195</CNPJ><xNome>Papelaria Central Ltda</xNome><xFant>Central</xFant><enderEmit><xMun>Florianópolis</xMun><UF>SC</UF></enderEmit></emit>
<dest><CNPJ>${destino}</CNPJ><xNome>BARBIERI SERVICOS</xNome></dest>
<det nItem="1"><prod><cProd>A1</cProd><xProd>Papel A4</xProd><NCM>48025610</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>10.0000</qCom><vUnCom>20.0000</vUnCom><vProd>200.00</vProd></prod></det>
<det nItem="2"><prod><cProd>B2</cProd><xProd>Caneta</xProd><NCM>96081000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>5.0000</qCom><vUnCom>10.0000</vUnCom><vProd>50.00</vProd></prod></det>
<total><ICMSTot><vProd>250.00</vProd><vFrete>10.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vICMS>0.00</vICMS><vIPI>0.00</vIPI><vNF>260.00</vNF></ICMSTot></total>
${extra}</infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${ch}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const cobr = '<cobr><dup><nDup>001</nDup><dVenc>2026-11-10</dVenc><vDup>130.00</vDup></dup><dup><nDup>002</nDup><dVenc>2026-12-10</dVenc><vDup>130.00</vDup></dup></cobr>';

test('compras: leitura da NF-e, importação, despesas, duplicidade, exclusão e relatório', async () => {
  const { migrar, db } = await import('../src/db.js');
  migrar();
  const { lerNfe } = await import('../src/nfe/leitura.js');
  const l = lerNfe(nfe(cobr));
  assert.equal(l.chave, chave);
  assert.equal(l.numero, '1234');
  assert.equal(l.emissao, '2026-10-10');
  assert.equal(l.fornecedor.nome, 'Papelaria Central Ltda');
  assert.equal(l.itens.length, 2);
  assert.equal(l.itens[0].quantidade, 10);
  assert.equal(l.totais.nf, 260);
  assert.equal(l.parcelas.length, 2);
  assert.throws(() => lerNfe('<CompNfse><x/></CompNfse>'), /NFS-e/);
  assert.throws(() => lerNfe('<abc/>'), /NF-e/);

  const { importarCompraXml, listarCompras, obterCompra, excluirCompra, criarCompraManual } = await import('../src/servicos/compras.js');
  const { gerarRelatorio } = await import('../src/servicos/relatorios.js');
  db.prepare("INSERT INTO escritorios (id, nome) VALUES (1, 'E')").run();
  db.prepare("INSERT INTO usuarios (id, escritorio_id, nome, email, papel, login, senha_hash) VALUES (1, 1, 'A', 'a@x.com', 'admin', 'A', 'x')").run();
  db.prepare("INSERT INTO empresas (id, escritorio_id, documento, razao_social, cod_municipio, op_simp_nac, ambiente) VALUES (1, 1, '10512356000168', 'BARBIERI', '4208203', 3, 2)").run();

  const r = importarCompraXml(1, 1, { xml: nfe(cobr), gerarDespesas: true, categoria: 'Material e equipamentos' });
  assert.equal(r.valor, 260);
  assert.equal(r.itens, 2);
  assert.equal(r.parcelas, 2);
  assert.deepEqual(r.alertas, []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM despesas').get() as any).n, 2);
  assert.equal((db.prepare("SELECT SUM(valor) AS v FROM despesas WHERE data = '2026-11-10'").get() as any).v, 130);

  assert.throws(() => importarCompraXml(1, 1, { xml: nfe(cobr), gerarDespesas: false, categoria: 'x' }), /já foi importada/);
  assert.throws(() => importarCompraXml(1, 1, { xml: nfe('', '35261012345678000195550010000012341000099999').replace('<CNPJ>12345678000195</CNPJ><xNome>Papelaria', '<CNPJ>10512356000168</CNPJ><xNome>Papelaria'), gerarDespesas: false, categoria: 'x' }), /própria empresa/);

  // sem parcelas e sem despesas, destinatário diferente gera alerta
  const r2 = importarCompraXml(1, 1, { xml: nfe('', '35261012345678000195550010000012341000055555', '99999999000199'), gerarDespesas: false, categoria: 'x' });
  assert.equal(r2.alertas.length, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM despesas').get() as any).n, 2, 'sem gerar despesas não lança');

  const m = criarCompraManual(1, 1, { fornecedor_nome: 'Mercadinho', emissao: '2026-10-12', valor_total: 80, gerarDespesas: true, categoria: 'Outras', vencimento: '2026-10-12', formaPagamento: 'PIX' });
  assert.ok(m.id);

  const lista = listarCompras(1, '2026-10');
  assert.equal(lista.compras.length, 3);
  assert.equal(lista.total, 600);
  const det = obterCompra(r.id);
  assert.equal(det.itens.length, 2);
  assert.equal(det.parcelas.length, 2);

  const rel = gerarRelatorio(1, 'compras', { de: '2026-10-01', ate: '2026-10-31' });
  assert.equal(rel.linhas.length, 3);
  assert.equal(rel.totais.total, 600);

  excluirCompra(r.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM despesas').get() as any).n, 1, 'despesas geradas pela compra saem junto');
  assert.equal(listarCompras(1, '2026-10').compras.length, 2);
});

test('compras: prévia do XML, parcelas ajustadas na importação e depois, e busca', async () => {
  const { db } = await import('../src/db.js');
  const { importarCompraXml, previaCompraXml, alterarParcelas, listarCompras, obterCompra } = await import('../src/servicos/compras.js');
  const ch = '35261012345678000195550010000012341000077777';
  const xml = nfe(cobr, ch);
  const pv = previaCompraXml(1, xml);
  assert.equal(pv.numero, '1234'); assert.equal(pv.itens.length, 2); assert.equal(pv.parcelas.length, 2); assert.equal(pv.parcelasDaNota, true);
  assert.equal(pv.bloqueio, null); assert.equal(pv.totais.nf, 260);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM compras WHERE chave_acesso = ?').get(ch) as any).n, 0, 'a prévia não grava');

  // parcelas que não fecham com o total são recusadas; as ajustadas valem no lugar das da nota
  assert.throws(() => importarCompraXml(1, 1, { xml, gerarDespesas: true, categoria: 'x', parcelas: [{ vencimento: '2026-11-15', valor: 100 }] }), /fechar com o total/);
  const r = importarCompraXml(1, 1, { xml, gerarDespesas: true, categoria: 'Material e equipamentos', parcelas: [{ vencimento: '2026-11-15', valor: 100 }, { vencimento: '2026-12-15', valor: 100 }, { vencimento: '2027-01-15', valor: 60 }] });
  let c = obterCompra(r.id);
  assert.deepEqual(c.parcelas.map((p: any) => [p.vencimento, p.valor]), [['2026-11-15', 100], ['2026-12-15', 100], ['2027-01-15', 60]]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM despesas WHERE descricao LIKE 'NF 1234%' AND valor IN (100, 60) AND data >= '2026-11-15'").get() as any).n, 3);
  assert.equal(previaCompraXml(1, xml).bloqueio?.includes('já foi importada'), true);

  // alterar depois: de 3 para 2 parcelas, a despesa que sobra é apagada
  const antes = (db.prepare('SELECT COUNT(*) n FROM despesas').get() as any).n;
  assert.throws(() => alterarParcelas(r.id, 1, [{ vencimento: '2026-11-20', valor: 50 }]), /fechar com o total/);
  alterarParcelas(r.id, 1, [{ vencimento: '2026-11-20', valor: 130 }, { vencimento: '2026-12-20', valor: 130 }]);
  c = obterCompra(r.id);
  assert.deepEqual(c.parcelas.map((p: any) => p.valor), [130, 130]);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM despesas').get() as any).n, antes - 1);
  assert.equal(c.parcelas.every((p: any) => p.despesa_id), true);

  // parcela já ligada ao extrato trava a alteração
  db.prepare("INSERT INTO extrato_importacoes (empresa_id, arquivo, qtd, hash) VALUES (1, 'x', 1, 'hh')").run();
  const lid = Number(db.prepare("INSERT INTO extrato_lancamentos (empresa_id, importacao_id, data, descricao, documento, valor, saldo, chave) VALUES (1, (SELECT MAX(id) FROM extrato_importacoes), '2026-11-20', 'PIX', '1', -130, 0, 'kk')").run().lastInsertRowid);
  db.prepare('UPDATE despesas SET extrato_lancamento_id = ? WHERE id = ?').run(lid, c.parcelas[0].despesa_id);
  assert.throws(() => alterarParcelas(r.id, 1, [{ vencimento: '2026-11-20', valor: 260 }]), /ligada ao extrato/);

  // busca por fornecedor, número, CNPJ e período
  assert.equal(listarCompras(1, null, { q: 'papelaria', de: '2026-10-01', ate: '2026-10-31' }).compras.length >= 1, true);
  assert.equal(listarCompras(1, null, { q: '12.345.678/0001-95' }).compras.length >= 1, true);
  assert.equal(listarCompras(1, null, { q: 'inexistente' }).compras.length, 0);
  assert.equal(listarCompras(1, null, { q: '1234', de: '2030-01-01', ate: '2030-12-31' }).compras.length, 0);
});

test('compras: importação das notas da SEFAZ aceita parcelas ajustadas', async () => {
  const { db } = await import('../src/db.js');
  const { previaCompraXml } = await import('../src/servicos/compras.js');
  const { importarRecebidas } = await import('../src/servicos/nfe-recebidas.js');
  const ch = '35261012345678000195550010000012341000088888';
  const xml = nfe(cobr, ch);
  db.prepare("INSERT INTO nfe_recebidas (empresa_id, chave, numero, emitente_nome, emissao, valor, situacao, xml) VALUES (1, ?, '1234', 'Papelaria', '2026-10-10', 260, 'AUTORIZADA', ?)").run(ch, xml);
  assert.equal(previaCompraXml(1, xml).parcelas.length, 2);
  const falha = importarRecebidas(1, 1, { chaves: [ch], gerarDespesas: true, categoria: 'x', parcelas: [{ vencimento: '2026-11-01', valor: 10 }] });
  assert.equal(falha.importadas, 0);
  const ok = importarRecebidas(1, 1, { chaves: [ch], gerarDespesas: true, categoria: 'x', parcelas: [{ vencimento: '2026-11-01', valor: 60 }, { vencimento: '2026-11-15', valor: 200 }] });
  assert.equal(ok.importadas, 1);
  const c = db.prepare("SELECT p.vencimento, p.valor FROM compra_parcelas p JOIN compras c ON c.id = p.compra_id WHERE c.chave_acesso = ? ORDER BY p.vencimento").all(ch) as any[];
  assert.deepEqual(c.map((x) => x.valor), [60, 200]);
});

test('compras: à vista exige forma de pagamento; manual parcelado; lista de fornecedores', async () => {
  const { db } = await import('../src/db.js');
  const { criarCompraManual, fornecedoresDaEmpresa, importarCompraXml } = await import('../src/servicos/compras.js');
  const base = { fornecedor_nome: 'Loja Nova', emissao: '2026-10-20', valor_total: 300, gerarDespesas: true, categoria: 'Outras' };
  assert.throws(() => criarCompraManual(1, 1, base), /forma de pagamento/);
  const av = criarCompraManual(1, 1, { ...base, formaPagamento: 'DEBITO' });
  assert.equal((db.prepare("SELECT forma_pagamento f FROM despesas d JOIN compra_parcelas p ON p.despesa_id = d.id WHERE p.compra_id = ?").get(av.id) as any).f, 'DEBITO');
  // parcelado não exige; a soma precisa fechar
  assert.throws(() => criarCompraManual(1, 1, { ...base, parcelas: [{ vencimento: '2026-11-20', valor: 100 }] }), /fechar com o total/);
  const pr = criarCompraManual(1, 1, { ...base, parcelas: [{ vencimento: '2026-11-20', valor: 150 }, { vencimento: '2026-12-20', valor: 150 }] });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM compra_parcelas WHERE compra_id = ? AND despesa_id IS NOT NULL').get(pr.id) as any).n, 2);
  // sem gerar despesas, não exige
  criarCompraManual(1, 1, { ...base, gerarDespesas: false });
  // XML sem duplicatas é à vista
  const xml = nfe('', '35261012345678000195550010000012341000066666');
  assert.throws(() => importarCompraXml(1, 1, { xml, gerarDespesas: true, categoria: 'x' }), /forma de pagamento/);
  importarCompraXml(1, 1, { xml, gerarDespesas: true, categoria: 'x', formaPagamento: 'PIX' });
  const f = fornecedoresDaEmpresa(1) as any[];
  assert.equal(f.some((x) => x.nome === 'Papelaria Central Ltda' && x.documento === '12345678000195' && x.notas >= 1), true);
  assert.equal(f.some((x) => x.nome === 'Loja Nova'), true);
});

test('contabilidade: pacote com XML das entradas (compras e SEFAZ não lançadas), com escolha', async () => {
  const { db } = await import('../src/db.js');
  const { pacoteContabilidade } = await import('../src/servicos/contabilidade.js');
  const { unzipSync, strFromU8 } = await import('fflate');
  const ch = '35261012345678000195550010000012341000099001';
  db.prepare("INSERT INTO nfe_recebidas (empresa_id, chave, numero, emitente_nome, emitente_documento, emissao, valor, situacao, xml) VALUES (1, ?, '777', 'Outro Fornecedor', '98765432000198', '2026-10-15', 90, 'AUTORIZADA', ?)").run(ch, nfe('', ch));
  const lista = (o: any) => pacoteContabilidade(1, { de: '2026-10-01', ate: '2026-10-31', xml: false, pdf: false, ofx: false, ...o }).then((r) => unzipSync(new Uint8Array(r.zip)));
  const so_compras = await lista({ entradas: true });
  assert.equal(Object.keys(so_compras).some((k) => k.includes(ch)), false, 'sem a opção da SEFAZ, a nota não lançada fica de fora');
  assert.equal(Object.keys(so_compras).some((k) => k.startsWith('entradas/xml/')), true);
  const so_sefaz = await lista({ sefaz: true });
  assert.deepEqual(Object.keys(so_sefaz).filter((k) => k.startsWith('entradas/xml/')), [`entradas/xml/NFe_${ch}.xml`]);
  assert.match(strFromU8(so_sefaz['entradas/relatorio-entradas.csv']), /Recebida da SEFAZ, não lançada/);
  const ambas = await lista({ entradas: true, sefaz: true });
  assert.equal(Object.keys(ambas).filter((k) => k.startsWith('entradas/xml/')).length >= 2, true);
  await assert.rejects(pacoteContabilidade(1, { de: '2026-10-01', ate: '2026-10-31', xml: false, pdf: false, ofx: false }), /ao menos um/);
});
