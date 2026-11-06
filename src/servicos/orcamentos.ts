import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { COR, MM, brl, cabecalho, dataBr, docFmt, emitenteDaEmpresa, rodapes, secao } from '../pdf/timbrado.js';

/**
 * Orçamento de serviços: itens, validade e condições, PDF para o cliente e conversão em NFS-e.
 * A conversão abre a tela de emissão já preenchida; cada nota emitida fica ligada ao orçamento
 * (orcamento_notas) e o saldo ainda não faturado é calculado a partir delas. A situação mostrada
 * (Vencido, Parcial, Faturado) é calculada na leitura, sem rotinas que precisem lembrar de atualizá-la.
 */
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const ItemOrcamento = z.object({
  servicoId: z.number().int().nullish(),
  descricao: z.string().trim().min(1, 'Descreva o serviço de cada item.').max(500),
  quantidade: z.number().positive('A quantidade precisa ser maior que zero.').max(1e6),
  valorUnitario: z.number().min(0, 'O valor não pode ser negativo.').max(1e9),
});
export const EntradaOrcamento = z.object({
  tomadorId: z.number().int().nullish(),
  clienteNome: z.string().trim().max(200).nullish(),
  clienteEmail: z.string().trim().email('E-mail do cliente inválido.').nullish().or(z.literal('')),
  clienteFone: z.string().trim().max(30).nullish(),
  validade: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')),
  condicoes: z.string().trim().max(2000).nullish(),
  observacoes: z.string().trim().max(2000).nullish(),
  desconto: z.number().min(0).max(1e9).default(0),
  itens: z.array(ItemOrcamento).min(1, 'Inclua ao menos um item.').max(50),
});
export type EntradaOrcamento = z.infer<typeof EntradaOrcamento>;

function conferirEmpresa(empresaId: number, d: EntradaOrcamento) {
  if (d.tomadorId && !db.prepare('SELECT 1 FROM tomadores WHERE id = ? AND empresa_id = ?').get(d.tomadorId, empresaId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (!d.tomadorId && !d.clienteNome) throw new ErroNegocio('Escolha o cliente ou informe o nome de quem vai receber o orçamento.');
  for (const i of d.itens) if (i.servicoId && !db.prepare('SELECT 1 FROM servicos WHERE id = ? AND empresa_id = ?').get(i.servicoId, empresaId)) throw new ErroNegocio('Serviço não encontrado.', 404);
  const bruto = r2(d.itens.reduce((s, i) => s + i.quantidade * i.valorUnitario, 0));
  if (d.desconto > bruto) throw new ErroNegocio('O desconto não pode ser maior que a soma dos itens.');
  if (bruto - d.desconto <= 0) throw new ErroNegocio('O total do orçamento precisa ser maior que zero.');
  return { bruto, total: r2(bruto - d.desconto) };
}

function gravarItens(id: number, itens: EntradaOrcamento['itens']) {
  db.prepare('DELETE FROM orcamento_itens WHERE orcamento_id = ?').run(id);
  const ins = db.prepare('INSERT INTO orcamento_itens (orcamento_id, ordem, servico_id, descricao, quantidade, valor_unitario, total) VALUES (?,?,?,?,?,?,?)');
  itens.forEach((i, n) => ins.run(id, n + 1, i.servicoId ?? null, i.descricao, i.quantidade, i.valorUnitario, r2(i.quantidade * i.valorUnitario)));
}

export function criarOrcamento(empresaId: number, usuarioId: number, d: EntradaOrcamento) {
  const { total } = conferirEmpresa(empresaId, d);
  return db.transaction(() => {
    const numero = ((db.prepare('SELECT MAX(numero) n FROM orcamentos WHERE empresa_id = ?').get(empresaId) as any).n ?? 0) + 1;
    const id = Number(db.prepare(`INSERT INTO orcamentos (empresa_id, numero, tomador_id, cliente_nome, cliente_email, cliente_fone, validade, condicoes, observacoes, desconto, total, criado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(empresaId, numero, d.tomadorId ?? null, d.clienteNome || null, d.clienteEmail || null, d.clienteFone || null, d.validade || null,
      d.condicoes || null, d.observacoes || null, d.desconto, total, usuarioId).lastInsertRowid);
    gravarItens(id, d.itens);
    return obterOrcamento(empresaId, id);
  })();
}

export function atualizarOrcamento(empresaId: number, id: number, d: EntradaOrcamento) {
  const o = db.prepare('SELECT * FROM orcamentos WHERE id = ? AND empresa_id = ?').get(id, empresaId) as any;
  if (!o) throw new ErroNegocio('Orçamento não encontrado.', 404);
  if (db.prepare('SELECT 1 FROM orcamento_notas WHERE orcamento_id = ?').get(id)) throw new ErroNegocio('Este orçamento já tem notas emitidas e não pode mais ser alterado. Duplique-o para fazer outro.');
  const { total } = conferirEmpresa(empresaId, d);
  db.transaction(() => {
    db.prepare(`UPDATE orcamentos SET tomador_id = ?, cliente_nome = ?, cliente_email = ?, cliente_fone = ?, validade = ?, condicoes = ?, observacoes = ?, desconto = ?, total = ?,
      atualizado_em = datetime('now') WHERE id = ?`).run(d.tomadorId ?? null, d.clienteNome || null, d.clienteEmail || null, d.clienteFone || null, d.validade || null, d.condicoes || null, d.observacoes || null, d.desconto, total, id);
    gravarItens(id, d.itens);
  })();
  return obterOrcamento(empresaId, id);
}

/** Situação mostrada: a gravada, mais Vencido (prazo passou sem resposta), Parcial e Faturado (pelas notas emitidas). */
export function situacaoEfetiva(base: string, validade: string | null, total: number, faturado: number, hoje = hojeBr()) {
  if (faturado > 0) return total - faturado > 0.004 ? 'PARCIAL' : 'FATURADO';
  if ((base === 'RASCUNHO' || base === 'ENVIADO') && validade && validade < hoje) return 'VENCIDO';
  return base;
}

export function obterOrcamento(empresaId: number, id: number) {
  const o = db.prepare(`SELECT o.*, t.nome AS tomador_nome, t.documento AS tomador_documento, t.email AS tomador_email, t.fone AS tomador_fone
    FROM orcamentos o LEFT JOIN tomadores t ON t.id = o.tomador_id WHERE o.id = ? AND o.empresa_id = ?`).get(id, empresaId) as any;
  if (!o) throw new ErroNegocio('Orçamento não encontrado.', 404);
  const itens = db.prepare('SELECT * FROM orcamento_itens WHERE orcamento_id = ? ORDER BY ordem').all(id) as any[];
  const notas = db.prepare(`SELECT n.id, n.n_nfse, n.n_dps, n.status, n.valor_servico, n.competencia, n.criado_em, v.valor, v.item_id
    FROM orcamento_notas v JOIN notas n ON n.id = v.nota_id WHERE v.orcamento_id = ? ORDER BY v.id`).all(id) as any[];
  const vale = notas.filter((n) => ['PENDENTE', 'AUTORIZADA', 'ERRO_COMUNICACAO'].includes(n.status));
  const faturado = r2(vale.reduce((s, n) => s + n.valor, 0));
  const itensComSaldo = itens.map((i) => {
    const f = r2(vale.filter((n) => n.item_id === i.id).reduce((s, n) => s + n.valor, 0));
    return { ...i, faturado: f };
  });
  return {
    ...o, itens: itensComSaldo, notas, faturado, saldo: r2(Math.max(0, o.total - faturado)),
    cliente: o.tomador_nome ?? o.cliente_nome, email: o.tomador_email ?? o.cliente_email, fone: o.tomador_fone ?? o.cliente_fone,
    situacao_base: o.situacao, situacao: situacaoEfetiva(o.situacao, o.validade, o.total, faturado),
  };
}

export function listarOrcamentos(empresaId: number) {
  const l = db.prepare(`SELECT o.id FROM orcamentos o WHERE o.empresa_id = ? ORDER BY o.numero DESC LIMIT 500`).all(empresaId) as { id: number }[];
  return l.map(({ id }) => { const { itens, notas, ...o } = obterOrcamento(empresaId, id); return { ...o, qtd_itens: itens.length, qtd_notas: notas.length }; });
}

export function mudarSituacao(empresaId: number, id: number, acao: 'ENVIADO' | 'APROVADO' | 'RECUSADO' | 'REABRIR', motivo?: string | null) {
  const o = obterOrcamento(empresaId, id);
  if (o.faturado > 0) throw new ErroNegocio('Este orçamento já tem notas emitidas; a situação não pode mais ser alterada.');
  if (acao === 'REABRIR') db.prepare("UPDATE orcamentos SET situacao = 'RASCUNHO', decidido_em = NULL, motivo_recusa = NULL, atualizado_em = datetime('now') WHERE id = ?").run(id);
  else if (acao === 'ENVIADO') db.prepare("UPDATE orcamentos SET situacao = CASE WHEN situacao = 'RASCUNHO' THEN 'ENVIADO' ELSE situacao END, enviado_em = datetime('now'), atualizado_em = datetime('now') WHERE id = ?").run(id);
  else db.prepare("UPDATE orcamentos SET situacao = ?, decidido_em = datetime('now'), motivo_recusa = ?, atualizado_em = datetime('now') WHERE id = ?").run(acao, acao === 'RECUSADO' ? motivo || null : null, id);
  return obterOrcamento(empresaId, id);
}

export function excluirOrcamento(empresaId: number, id: number) {
  obterOrcamento(empresaId, id);
  if (db.prepare('SELECT 1 FROM orcamento_notas WHERE orcamento_id = ?').get(id)) throw new ErroNegocio('Este orçamento tem notas emitidas e não pode ser excluído.');
  db.prepare('DELETE FROM orcamentos WHERE id = ?').run(id);
  return { ok: true };
}

export function duplicarOrcamento(empresaId: number, usuarioId: number, id: number) {
  const o = obterOrcamento(empresaId, id);
  return criarOrcamento(empresaId, usuarioId, {
    tomadorId: o.tomador_id, clienteNome: o.cliente_nome, clienteEmail: o.cliente_email, clienteFone: o.cliente_fone, validade: null, condicoes: o.condicoes, observacoes: o.observacoes, desconto: o.desconto,
    itens: o.itens.map((i: any) => ({ servicoId: i.servico_id, descricao: i.descricao, quantidade: i.quantidade, valorUnitario: i.valor_unitario })),
  });
}

/**
 * Dados para preencher a tela de emissão. `item` = nota de um item (o que falta faturar dele);
 * sem `item` = uma nota única somando os itens (o saldo do orçamento). `valor` permite faturar só uma parte.
 */
export function conversao(empresaId: number, id: number, item: number | null, valor: number | null) {
  const o = obterOrcamento(empresaId, id);
  if (o.situacao_base === 'RECUSADO') throw new ErroNegocio('Este orçamento foi recusado pelo cliente.');
  if (o.situacao_base === 'RASCUNHO') throw new ErroNegocio('Marque o orçamento como enviado ou aprovado antes de converter em nota.');
  let descricao: string, servicoId: number | null, maximo: number;
  if (item) {
    const i = o.itens.find((x: any) => x.id === item);
    if (!i) throw new ErroNegocio('Item não encontrado.', 404);
    maximo = r2(Math.min(i.total - i.faturado, o.saldo));
    descricao = i.quantidade === 1 ? i.descricao : `${i.descricao} (${i.quantidade} x ${brl(i.valor_unitario)})`;
    servicoId = i.servico_id;
  } else {
    maximo = o.saldo;
    descricao = o.itens.length === 1 ? o.itens[0].descricao : o.itens.map((i: any) => i.descricao).join('; ');
    const ids = new Set(o.itens.map((i: any) => i.servico_id));
    servicoId = ids.size === 1 ? [...ids][0] as number | null : null;
  }
  if (maximo <= 0.004) throw new ErroNegocio(item ? 'Este item já foi faturado por inteiro.' : 'Este orçamento já foi faturado por inteiro.');
  const v = valor == null ? maximo : r2(valor);
  if (v <= 0 || v > maximo + 0.004) throw new ErroNegocio(`O valor da nota precisa ficar entre R$ 0,01 e ${brl(maximo)} (o que falta faturar).`);
  return { orcamentoId: id, numero: o.numero, itemId: item, tomadorId: o.tomador_id, cliente: o.cliente, servicoId, descricao: descricao.slice(0, 2000), valor: v, maximo };
}

/** Confere, antes de emitir, que o valor da nota cabe no saldo do orçamento. */
export function conferirAntesDeEmitir(empresaId: number, orcamentoId: number, itemId: number | null | undefined, valor: number) {
  conversao(empresaId, orcamentoId, itemId ?? null, valor);
}

/** Liga a nota recém-criada ao orçamento (e dá o orçamento por aprovado, já que o cliente aceitou ao pedir a nota). */
export function vincularNota(empresaId: number, orcamentoId: number, itemId: number | null | undefined, notaId: number, valor: number) {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO orcamento_notas (orcamento_id, nota_id, item_id, valor) VALUES (?,?,?,?)').run(orcamentoId, notaId, itemId ?? null, valor);
    db.prepare("UPDATE orcamentos SET situacao = 'APROVADO', decidido_em = COALESCE(decidido_em, datetime('now')), atualizado_em = datetime('now') WHERE id = ? AND empresa_id = ? AND situacao IN ('RASCUNHO','ENVIADO')").run(orcamentoId, empresaId);
  })();
}

// ---- PDF ----
export function orcamentoPdf(empresaId: number, id: number): Promise<{ pdf: Buffer; nome: string }> {
  const o = obterOrcamento(empresaId, id);
  const em = emitenteDaEmpresa(empresaId);
  const t = o.tomador_id ? (db.prepare('SELECT * FROM tomadores WHERE id = ?').get(o.tomador_id) as any) : null;
  return new Promise((ok, falha) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Orçamento ${o.numero} - ${o.cliente}` } });
    const partes: Buffer[] = []; pdf.on('data', (b) => partes.push(b)); pdf.on('error', falha);
    pdf.on('end', () => ok({ pdf: Buffer.concat(partes), nome: `Orcamento_${o.numero}_${String(o.cliente ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').slice(0, 40)}.pdf` }));
    const X = 16 * MM, W = pdf.page.width - 2 * X, LIM = pdf.page.height - 24 * MM;
    const txt = (s: string, x: number, y: number, op: any = {}) => pdf.fillColor(op.cor ?? COR.texto).font(op.negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(op.tam ?? 9).text(s, x, y, { width: op.w ?? W, align: op.align ?? 'left', lineGap: op.lg ?? 1 });
    let y = cabecalho(pdf, em, { titulo: `Orçamento nº ${o.numero}`, subtitulo: `Emitido em ${dataBr(o.criado_em)}${o.validade ? ` · válido até ${dataBr(o.validade)}` : ''}` });

    pdf.rect(X, y, W, 18 * MM).fillAndStroke(COR.fundo, COR.linha);
    txt('PARA', X + 4 * MM, y + 3.5 * MM, { cor: COR.destaque, negrito: true, tam: 8 });
    txt(String(o.cliente ?? ''), X + 4 * MM, y + 8 * MM, { negrito: true, tam: 10, w: W - 8 * MM });
    const contato = [o.tomador_documento ? `${String(o.tomador_documento).replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ'}: ${docFmt(o.tomador_documento)}` : '', o.email, o.fone].filter(Boolean).join('  ·  ');
    if (contato) txt(contato, X + 4 * MM, y + 13 * MM, { cor: COR.cinza, tam: 8, w: W - 8 * MM });
    void t;
    y += 18 * MM + 7 * MM;

    y = secao(pdf, 'Serviços', X, y);
    const cols = [{ n: 'Descrição', w: 0.52 }, { n: 'Qtd.', w: 0.1, r: true }, { n: 'Valor unit.', w: 0.18, r: true }, { n: 'Total', w: 0.2, r: true }];
    const cab = () => {
      pdf.rect(X, y, W, 6.5 * MM).fill(COR.claro); pdf.moveTo(X, y + 6.5 * MM).lineTo(X + W, y + 6.5 * MM).lineWidth(1).stroke(COR.destaque);
      let x = X; for (const c of cols) { txt(c.n, x + 3, y + 2 * MM, { negrito: true, tam: 7.8, w: c.w * W - 6, align: c.r ? 'right' : 'left' }); x += c.w * W; }
      y += 6.5 * MM + 1.5;
    };
    cab();
    for (const i of o.itens) {
      const h = Math.max(6.5 * MM, pdf.fontSize(9).heightOfString(i.descricao, { width: cols[0].w * W - 6 }) + 3 * MM);
      if (y + h > LIM) { pdf.addPage(); y = cabecalho(pdf, em, { titulo: `Orçamento nº ${o.numero}`, compacto: true }) + 4 * MM; cab(); }
      const cel = [i.descricao, String(i.quantidade).replace('.', ','), brl(i.valor_unitario), brl(i.total)];
      let x = X; cols.forEach((c, k) => { txt(cel[k], x + 3, y + 2 * MM, { w: c.w * W - 6, align: c.r ? 'right' : 'left' }); x += c.w * W; });
      y += h; pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.4).stroke(COR.linha);
    }
    y += 4 * MM;
    if (y + 28 * MM > LIM) { pdf.addPage(); y = cabecalho(pdf, em, { titulo: `Orçamento nº ${o.numero}`, compacto: true }) + 4 * MM; }
    if (o.desconto > 0) {
      txt('Desconto', X, y, { w: W - 36 * MM, align: 'right', cor: COR.cinza }); txt(`- ${brl(o.desconto)}`, X + W - 34 * MM, y, { w: 34 * MM, align: 'right' }); y += 6 * MM;
    }
    pdf.rect(X + W - 80 * MM, y, 80 * MM, 10 * MM).fill(COR.escuro);
    txt('TOTAL', X + W - 78 * MM, y + 3.2 * MM, { cor: '#ffffff', negrito: true, tam: 9, w: 30 * MM });
    txt(brl(o.total), X + W - 48 * MM, y + 2.6 * MM, { cor: '#ffffff', negrito: true, tam: 12, w: 46 * MM, align: 'right' });
    y += 10 * MM + 7 * MM;

    for (const [titulo, texto] of [['Condições', o.condicoes], ['Observações', o.observacoes]] as const) {
      if (!texto) continue;
      const h = pdf.fontSize(9).heightOfString(texto, { width: W }) + 14 * MM;
      if (y + h > LIM) { pdf.addPage(); y = cabecalho(pdf, em, { titulo: `Orçamento nº ${o.numero}`, compacto: true }) + 4 * MM; }
      y = secao(pdf, titulo, X, y);
      txt(texto, X, y, { lg: 2 }); y = pdf.y + 6 * MM;
    }
    if (o.validade) txt(`Proposta válida até ${dataBr(o.validade)}. A nota fiscal de serviço é emitida na contratação ou na entrega, conforme combinado.`, X, y, { tam: 8, cor: COR.cinza });
    rodapes(pdf, em);
    pdf.end();
  });
}
