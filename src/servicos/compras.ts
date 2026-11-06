import { z } from 'zod';
import { db } from '../db.js';
import { lerNfe } from '../nfe/leitura.js';
import { ErroNegocio } from './emissao.js';
import { conferirTipoDoVinculo, tipoPadrao } from './tributacao.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const soDig = (s: string | null | undefined) => String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export const FormaPagamento = z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO']);

/** À vista: uma parcela só, vencendo na data da compra (ou antes). Nesse caso a forma de pagamento é obrigatória. */
function exigirFormaAVista(gerar: boolean, parcelas: { vencimento: string }[], emissao: string, forma: string | null | undefined) {
  if (gerar && parcelas.length === 1 && parcelas[0].vencimento <= emissao && !forma) throw new ErroNegocio('Compra à vista: informe a forma de pagamento (PIX, débito, crédito ou dinheiro).');
}

export const ParcelaEditada = z.object({
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Vencimento inválido'),
  valor: z.number().positive('O valor da parcela precisa ser maior que zero'),
  numero: z.string().max(20).nullish(),
});

function conferirSoma(parcelas: { valor: number }[], total: number) {
  const soma = r2(parcelas.reduce((a, p) => a + p.valor, 0));
  if (Math.abs(soma - total) > 0.01) throw new ErroNegocio(`A soma das parcelas (R$ ${soma.toFixed(2)}) precisa fechar com o total da nota (R$ ${total.toFixed(2)}).`);
}

export const OpcoesImportacao = z.object({
  xml: z.string().min(200),
  /** Lança as parcelas (ou o total, se à vista) como despesas na data de vencimento. */
  gerarDespesas: z.boolean().default(false),
  categoria: z.string().trim().max(60).default('Material e equipamentos'),
  tipoDocumentoId: z.number().int().nullish(),
  /** Parcelas conferidas pelo usuário; substituem as da nota quando o pagamento real é diferente. */
  parcelas: z.array(ParcelaEditada).max(60).optional(),
  /** Forma de pagamento das despesas geradas; obrigatória quando a compra é à vista. */
  formaPagamento: FormaPagamento.nullish(),
});

function lancarDespesa(empresaId: number, usuarioId: number, data: string, categoria: string, descricao: string, valor: number, forma?: string | null) {
  return Number(db.prepare('INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, criado_por, forma_pagamento) VALUES (?,?,?,?,?,?,?)')
    .run(empresaId, data, categoria, descricao.slice(0, 200), valor, usuarioId, forma ?? null).lastInsertRowid);
}

export function importarCompraXml(empresaId: number, usuarioId: number, entrada: z.infer<typeof OpcoesImportacao>) {
  const empresa = db.prepare('SELECT documento FROM empresas WHERE id = ?').get(empresaId) as { documento: string } | undefined;
  if (!empresa) throw new ErroNegocio('Empresa não encontrada.', 404);
  let nfe: ReturnType<typeof lerNfe>;
  try { nfe = lerNfe(entrada.xml); } catch (e: any) { throw new ErroNegocio(e.message ?? 'XML inválido.'); }
  if (soDig(nfe.fornecedor.documento) === soDig(empresa.documento)) throw new ErroNegocio('Esta NF-e foi emitida pela própria empresa (é uma venda), não uma compra.');
  if (db.prepare('SELECT 1 FROM compras WHERE empresa_id = ? AND chave_acesso = ?').get(empresaId, nfe.chave)) throw new ErroNegocio(`A NF-e ${nfe.numero} de ${nfe.fornecedor.nome} já foi importada.`);
  const alertas: string[] = [];
  if (nfe.destinatario.documento && soDig(nfe.destinatario.documento) !== soDig(empresa.documento)) {
    alertas.push(`O destinatário da nota (${nfe.destinatario.nome ?? nfe.destinatario.documento}) não é esta empresa. Confira se a compra foi lançada na empresa certa.`);
  }
  const t = nfe.totais;
  const totalCalc = r2(t.produtos + t.frete + t.seguro + t.outras + t.icmsSt + t.ipi - t.desconto);
  if (t.nf <= 0) throw new ErroNegocio('A NF-e não traz o valor total (vNF).');
  if (Math.abs(totalCalc - t.nf) > 0.05) alertas.push(`O total da nota (R$ ${t.nf.toFixed(2)}) difere da soma dos componentes (R$ ${totalCalc.toFixed(2)}); foi mantido o total informado na nota.`);
  if (entrada.parcelas?.length) conferirSoma(entrada.parcelas, t.nf);
  const somaParc = r2(nfe.parcelas.reduce((a, p) => a + p.valor, 0));
  if (nfe.parcelas.length && Math.abs(somaParc - t.nf) > 0.05) alertas.push(`A soma das parcelas (R$ ${somaParc.toFixed(2)}) difere do total da nota.`);

  const tipoId = conferirTipoDoVinculo(empresaId, entrada.tipoDocumentoId, 'ENTRADA') ?? tipoPadrao(empresaId, 'ENTRADA')?.id ?? null;
  exigirFormaAVista(entrada.gerarDespesas, entrada.parcelas?.length ? entrada.parcelas : nfe.parcelas.length ? nfe.parcelas : [{ vencimento: nfe.emissao }], nfe.emissao, entrada.formaPagamento);
  const id = db.transaction(() => {
    const cid = Number(db.prepare(`INSERT INTO compras (empresa_id, fornecedor_documento, fornecedor_nome, numero, serie, chave_acesso, emissao, natureza, categoria,
        valor_produtos, valor_frete, valor_desconto, valor_outras, valor_icms, valor_ipi, valor_total, xml, origem, criado_por, tipo_documento_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'XML',?,?)`).run(
      empresaId, nfe.fornecedor.documento, nfe.fornecedor.nome, nfe.numero, nfe.serie, nfe.chave, nfe.emissao, nfe.natureza, entrada.gerarDespesas ? entrada.categoria : null,
      t.produtos, t.frete + t.seguro, t.desconto, t.outras, t.icms, t.ipi, t.nf, entrada.xml, usuarioId, tipoId).lastInsertRowid);
    const ins = db.prepare('INSERT INTO compra_itens (compra_id, n_item, codigo, descricao, ncm, cfop, unidade, quantidade, valor_unitario, valor_total, desconto) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const i of nfe.itens) ins.run(cid, i.n, i.codigo, i.descricao, i.ncm, i.cfop, i.unidade, i.quantidade, i.valorUnit, i.valor, i.desconto);
    const parcelas = entrada.parcelas?.length ? entrada.parcelas.map((p) => ({ numero: p.numero ?? null, vencimento: p.vencimento, valor: p.valor })) : nfe.parcelas.length ? nfe.parcelas : [{ numero: null as string | null, vencimento: nfe.emissao, valor: t.nf }];
    const insP = db.prepare('INSERT INTO compra_parcelas (compra_id, numero, vencimento, valor, despesa_id) VALUES (?,?,?,?,?)');
    parcelas.forEach((p, k) => {
      const desp = entrada.gerarDespesas
        ? lancarDespesa(empresaId, usuarioId, p.vencimento, entrada.categoria, `NF ${nfe.numero} — ${nfe.fornecedor.nome}${parcelas.length > 1 ? ` (parcela ${k + 1}/${parcelas.length})` : ''}`, p.valor, entrada.formaPagamento)
        : null;
      insP.run(cid, p.numero, p.vencimento, p.valor, desp);
    });
    return cid;
  })();
  return { id, numero: nfe.numero, fornecedor: nfe.fornecedor.nome, valor: t.nf, itens: nfe.itens.length, parcelas: nfe.parcelas.length, alertas };
}

/** Resumo do XML antes de importar: fornecedor, totais, itens e o parcelamento da nota. Não grava nada. */
export function previaCompraXml(empresaId: number, xml: string) {
  const empresa = db.prepare('SELECT documento FROM empresas WHERE id = ?').get(empresaId) as { documento: string } | undefined;
  if (!empresa) throw new ErroNegocio('Empresa não encontrada.', 404);
  let nfe: ReturnType<typeof lerNfe>;
  try { nfe = lerNfe(xml); } catch (e: any) { throw new ErroNegocio(e.message ?? 'XML inválido.'); }
  const alertas: string[] = [];
  let bloqueio: string | null = null;
  if (soDig(nfe.fornecedor.documento) === soDig(empresa.documento)) bloqueio = 'Esta NF-e foi emitida pela própria empresa (é uma venda), não uma compra.';
  else if (db.prepare('SELECT 1 FROM compras WHERE empresa_id = ? AND chave_acesso = ?').get(empresaId, nfe.chave)) bloqueio = `A NF-e ${nfe.numero} de ${nfe.fornecedor.nome} já foi importada.`;
  if (nfe.destinatario.documento && soDig(nfe.destinatario.documento) !== soDig(empresa.documento)) alertas.push(`O destinatário da nota (${nfe.destinatario.nome ?? nfe.destinatario.documento}) não é esta empresa.`);
  const t = nfe.totais;
  if (nfe.parcelas.length && Math.abs(r2(nfe.parcelas.reduce((a, p) => a + p.valor, 0)) - t.nf) > 0.05) alertas.push('A soma das parcelas da nota difere do total; ajuste o parcelamento abaixo.');
  return {
    chave: nfe.chave, numero: nfe.numero, serie: nfe.serie, emissao: nfe.emissao, natureza: nfe.natureza,
    fornecedor: nfe.fornecedor, destinatario: nfe.destinatario, totais: t,
    itens: nfe.itens.map((i) => ({ n: i.n, descricao: i.descricao, ncm: i.ncm, quantidade: i.quantidade, unidade: i.unidade, valorUnit: i.valorUnit, valor: i.valor })),
    parcelas: nfe.parcelas.length ? nfe.parcelas : [{ numero: null, vencimento: nfe.emissao, valor: t.nf }],
    parcelasDaNota: nfe.parcelas.length > 0, alertas, bloqueio,
  };
}

/** Troca o parcelamento de uma compra já lançada. Reaproveita as despesas existentes (atualiza, cria ou apaga as que sobram). */
export function alterarParcelas(compraId: number, usuarioId: number, parcelas: z.infer<typeof ParcelaEditada>[]) {
  const c = db.prepare('SELECT id, empresa_id, valor_total, numero, fornecedor_nome, categoria FROM compras WHERE id = ?').get(compraId) as any;
  if (!c) throw new ErroNegocio('Compra não encontrada.', 404);
  if (!parcelas.length) throw new ErroNegocio('Informe ao menos uma parcela.');
  conferirSoma(parcelas, c.valor_total);
  const antigas = db.prepare('SELECT id, despesa_id FROM compra_parcelas WHERE compra_id = ? ORDER BY vencimento, id').all(compraId) as { id: number; despesa_id: number | null }[];
  const despesas = antigas.map((a) => a.despesa_id).filter((x): x is number => x !== null);
  const geraDespesas = despesas.length > 0;
  if (geraDespesas) {
    const ligada = db.prepare(`SELECT 1 FROM despesas WHERE id IN (${despesas.join(',')}) AND extrato_lancamento_id IS NOT NULL`).get();
    if (ligada) throw new ErroNegocio('Há parcela já ligada ao extrato. Desfaça o vínculo em Extrato e conciliação antes de alterar o parcelamento.');
  }
  const ordenadas = [...parcelas].sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  db.transaction(() => {
    db.prepare('DELETE FROM compra_parcelas WHERE compra_id = ?').run(compraId);
    const insP = db.prepare('INSERT INTO compra_parcelas (compra_id, numero, vencimento, valor, despesa_id) VALUES (?,?,?,?,?)');
    const cat = c.categoria ?? 'Material e equipamentos';
    ordenadas.forEach((p, k) => {
      let did: number | null = null;
      if (geraDespesas) {
        const desc = `${c.numero ? 'NF ' + c.numero : 'Compra'} — ${c.fornecedor_nome}${ordenadas.length > 1 ? ` (parcela ${k + 1}/${ordenadas.length})` : ''}`.slice(0, 200);
        const reaproveita = despesas[k];
        if (reaproveita) { db.prepare('UPDATE despesas SET data = ?, valor = ?, descricao = ? WHERE id = ?').run(p.vencimento, p.valor, desc, reaproveita); did = reaproveita; }
        else did = lancarDespesa(c.empresa_id, usuarioId, p.vencimento, cat, desc, p.valor);
      }
      insP.run(compraId, p.numero ?? (ordenadas.length > 1 ? String(k + 1).padStart(3, '0') : null), p.vencimento, p.valor, did);
    });
    for (const sobra of despesas.slice(ordenadas.length)) db.prepare('DELETE FROM despesas WHERE id = ?').run(sobra);
  })();
  return { ok: true, parcelas: ordenadas.length };
}

export const CompraManual = z.object({
  fornecedor_nome: z.string().trim().min(2, 'Informe o fornecedor').max(120),
  fornecedor_documento: z.string().trim().max(20).nullish(),
  numero: z.string().trim().max(30).nullish(),
  emissao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida'),
  valor_total: z.number().positive('O valor precisa ser maior que zero'),
  observacao: z.string().trim().max(300).nullish(),
  gerarDespesas: z.boolean().default(false),
  categoria: z.string().trim().max(60).default('Material e equipamentos'),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  tipoDocumentoId: z.number().int().nullish(),
  /** Parcelamento (soma = valor total). Sem ele, vale uma parcela única em `vencimento` (ou na data da compra). */
  parcelas: z.array(ParcelaEditada).max(60).optional(),
  formaPagamento: FormaPagamento.nullish(),
});

export function criarCompraManual(empresaId: number, usuarioId: number, d: z.infer<typeof CompraManual>) {
  const tipoId = conferirTipoDoVinculo(empresaId, d.tipoDocumentoId, 'ENTRADA') ?? tipoPadrao(empresaId, 'ENTRADA')?.id ?? null;
  const parcelas = d.parcelas?.length ? [...d.parcelas].sort((x, y) => x.vencimento.localeCompare(y.vencimento)) : [{ numero: null as string | null | undefined, vencimento: d.vencimento ?? d.emissao, valor: d.valor_total }];
  conferirSoma(parcelas, d.valor_total);
  exigirFormaAVista(d.gerarDespesas, parcelas, d.emissao, d.formaPagamento);
  return db.transaction(() => {
    const cid = Number(db.prepare(`INSERT INTO compras (empresa_id, fornecedor_documento, fornecedor_nome, numero, emissao, categoria, observacao, valor_produtos, valor_total, origem, criado_por, tipo_documento_id)
      VALUES (?,?,?,?,?,?,?,?,?,'MANUAL',?,?)`).run(empresaId, d.fornecedor_documento ?? null, d.fornecedor_nome, d.numero ?? null, d.emissao, d.gerarDespesas ? d.categoria : null, d.observacao ?? null, d.valor_total, d.valor_total, usuarioId, tipoId).lastInsertRowid);
    const insP = db.prepare('INSERT INTO compra_parcelas (compra_id, numero, vencimento, valor, despesa_id) VALUES (?,?,?,?,?)');
    parcelas.forEach((p, k) => {
      const desp = d.gerarDespesas ? lancarDespesa(empresaId, usuarioId, p.vencimento, d.categoria, `Compra${d.numero ? ' ' + d.numero : ''} — ${d.fornecedor_nome}${parcelas.length > 1 ? ` (parcela ${k + 1}/${parcelas.length})` : ''}`, p.valor, d.formaPagamento) : null;
      insP.run(cid, p.numero ?? (parcelas.length > 1 ? String(k + 1).padStart(3, '0') : null), p.vencimento, p.valor, desp);
    });
    return { id: cid };
  })();
}

/** Fornecedores que já tiveram nota lançada (para a consulta por F2 e o preenchimento automático). */
export function fornecedoresDaEmpresa(empresaId: number) {
  return db.prepare(`SELECT MAX(fornecedor_nome) AS nome, fornecedor_documento AS documento, COUNT(*) AS notas, MAX(emissao) AS ultima
    FROM compras WHERE empresa_id = ? GROUP BY COALESCE(NULLIF(fornecedor_documento, ''), fornecedor_nome) ORDER BY nome COLLATE NOCASE`).all(empresaId);
}

export function listarCompras(empresaId: number, mes: string | null, busca?: { q?: string; de?: string; ate?: string }) {
  const q = (busca?.q ?? '').trim();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const dig = q.replace(/\D/g, '');
  const linhas = db.prepare(`SELECT c.id, c.fornecedor_nome, c.fornecedor_documento, c.numero, c.serie, c.emissao, c.valor_total, c.origem, c.categoria,
      (SELECT COUNT(*) FROM compra_itens i WHERE i.compra_id = c.id) AS itens,
      (SELECT COUNT(*) FROM compra_parcelas p WHERE p.compra_id = c.id AND p.despesa_id IS NOT NULL) AS despesas
    FROM compras c WHERE c.empresa_id = ? AND ${mes ? 'substr(c.emissao,1,7) = ?' : 'c.emissao BETWEEN ? AND ?'}
      ${q ? 'AND (c.fornecedor_nome LIKE ? OR c.numero LIKE ? OR c.chave_acesso LIKE ? OR (? <> \'\' AND c.fornecedor_documento LIKE ?))' : ''}
    ORDER BY c.emissao DESC, c.id DESC`).all(empresaId, ...(mes ? [mes] : [busca?.de ?? '0000-01-01', busca?.ate ?? '9999-12-31']), ...(q ? [like, like, like, dig, `%${dig}%`] : [])) as any[];
  const porFornecedor = new Map<string, number>();
  for (const l of linhas) porFornecedor.set(l.fornecedor_nome, r2((porFornecedor.get(l.fornecedor_nome) ?? 0) + l.valor_total));
  return {
    compras: linhas,
    total: r2(linhas.reduce((a, l) => a + l.valor_total, 0)),
    fornecedores: [...porFornecedor.entries()].map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total).slice(0, 5),
  };
}

export function obterCompra(id: number) {
  const c = db.prepare('SELECT id, empresa_id, tipo_documento_id, fornecedor_documento, fornecedor_nome, numero, serie, chave_acesso, emissao, natureza, categoria, observacao, valor_produtos, valor_frete, valor_desconto, valor_outras, valor_icms, valor_ipi, valor_total, origem, criado_em, (xml IS NOT NULL) AS tem_xml FROM compras WHERE id = ?').get(id) as any;
  if (!c) throw new ErroNegocio('Compra não encontrada.', 404);
  c.itens = db.prepare('SELECT n_item, codigo, descricao, ncm, cfop, unidade, quantidade, valor_unitario, valor_total, desconto FROM compra_itens WHERE compra_id = ? ORDER BY n_item').all(id);
  c.parcelas = db.prepare('SELECT numero, vencimento, valor, despesa_id FROM compra_parcelas WHERE compra_id = ? ORDER BY vencimento, id').all(id);
  return c;
}

export function xmlDaCompra(id: number): { xml: string; nome: string } {
  const c = db.prepare('SELECT xml, chave_acesso, numero FROM compras WHERE id = ?').get(id) as any;
  if (!c?.xml) throw new ErroNegocio('Esta compra não tem XML.', 404);
  return { xml: c.xml, nome: `NFe-${c.chave_acesso ?? c.numero}.xml` };
}

/** Apaga a compra e as despesas que ela gerou. */
export function excluirCompra(id: number) {
  const c = db.prepare('SELECT id FROM compras WHERE id = ?').get(id);
  if (!c) throw new ErroNegocio('Compra não encontrada.', 404);
  db.transaction(() => {
    for (const p of db.prepare('SELECT despesa_id FROM compra_parcelas WHERE compra_id = ? AND despesa_id IS NOT NULL').all(id) as { despesa_id: number }[]) {
      db.prepare('DELETE FROM despesas WHERE id = ?').run(p.despesa_id);
    }
    db.prepare('DELETE FROM compra_itens WHERE compra_id = ?').run(id);
    db.prepare('DELETE FROM compra_parcelas WHERE compra_id = ?').run(id);
    db.prepare('DELETE FROM compras WHERE id = ?').run(id);
  })();
  return { ok: true };
}
