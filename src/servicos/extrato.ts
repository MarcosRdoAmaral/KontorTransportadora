import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { listarCategorias } from './financeiro.js';
import { marcarPago } from './cobranca.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Leitura do PDF (extrato de conta corrente no layout homologado, banco 085)
// ---------------------------------------------------------------------------
export interface LancamentoLido { data: string; descricao: string; documento: string; valor: number; saldo: number }
export interface ExtratoLido {
  nome?: string; agencia?: string; conta?: string; periodoIni?: string; periodoFim?: string;
  saldoAnterior?: number; saldoFinal?: number; totalCredito?: number; totalDebito?: number;
  lancamentos: LancamentoLido[]; avisos: string[];
}

const dinheiro = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
const ehDinheiro = (s: string) => /^-?\d{1,3}(\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/.test(s);
const iso = (d: string) => d.split('/').reverse().join('-');

interface Item { x: number; y: number; fim: number; s: string }

export async function lerPdfExtrato(pdf: Buffer): Promise<ExtratoLido> {
  // @ts-ignore — build "legacy" do pdf.js roda em Node sem navegador
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: any;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, useSystemFonts: false }).promise; }
  catch { throw new ErroNegocio('Não foi possível abrir o PDF. Confira se é o extrato exportado pelo banco.'); }

  const out: ExtratoLido = { lancamentos: [], avisos: [] };
  const textoCab: string[] = [];
  let totais: number[] | null = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const itens: Item[] = (await pg.getTextContent()).items
      .filter((i: any) => i.str !== undefined)
      .map((i: any) => ({ x: i.transform[4], y: i.transform[5], fim: i.transform[4] + i.width, s: String(i.str) }));
    // agrupa por linha (as colunas ficam até ~0,5pt fora de alinhamento)
    const linhas: { y: number; it: Item[] }[] = [];
    for (const it of [...itens].sort((a, b) => b.y - a.y)) {
      const l = linhas.find((k) => Math.abs(k.y - it.y) < 2.5);
      l ? l.it.push(it) : linhas.push({ y: it.y, it: [it] });
    }
    const txt = (it: Item[]) => it.sort((a, b) => a.x - b.x).map((i) => i.s).join('').replace(/\s+/g, ' ').trim();

    // limites das colunas, lidos do cabeçalho de cada página
    const cab = linhas.find((l) => l.it.some((i) => i.s.trim() === 'DOCUMENTO'));
    let fimDoc = 350, fimCred = 427, fimDeb = 505;
    if (cab) {
      const ord = [...cab.it].sort((a, b) => a.x - b.x).filter((i) => i.s.trim());
      const doc_ = ord.find((i) => i.s.trim() === 'DOCUMENTO'); if (doc_) fimDoc = doc_.fim;
      const rs = ord.filter((i) => i.s.trim() === '(R$)'); // crédito, débito
      if (rs[0]) fimCred = rs[0].fim; if (rs[1]) fimDeb = rs[1].fim;
    }

    for (const l of linhas) {
      const data = l.it.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.s.trim()) && i.x < 70);
      const t = txt([...l.it]);
      if (!data) {
        if (/^SALDO ANTERIOR/.test(t)) { const m = t.match(/(-?[\d.]+,\d{2})$/); if (m) out.saldoAnterior = dinheiro(m[1]); }
        else if (/^TOTAL\b/.test(t)) { const n = t.match(/-?[\d.]+,\d{2}/g)?.map(dinheiro); if (n?.length === 3) totais = n; }
        else if (p === 1 && !cab) textoCab.push(t);
        else if (l.it.every((i) => i.y > (cab?.y ?? 0))) textoCab.push(t);
        continue;
      }
      const resto = l.it.filter((i) => i !== data && (i.s.trim() || (i.fim - i.x < 10 && i.x < 295)));
      const desc: Item[] = [], docs: Item[] = [], cred: Item[] = [], deb: Item[] = [], sal: Item[] = [];
      for (const i of resto) {
        if (i.x < 295 && i.fim < fimDoc - 20) desc.push(i);
        else if (i.fim <= fimDoc + 6) docs.push(i);
        else if (i.fim <= fimCred + 6) cred.push(i);
        else if (i.fim <= fimDeb + 6) deb.push(i);
        else sal.push(i);
      }
      const dinheiros = (a: Item[]) => txt(a);
      const vc = dinheiros(cred), vd = dinheiros(deb), vs = dinheiros(sal);
      const valorTxt = vc || vd;
      if (!ehDinheiro(valorTxt) || !ehDinheiro(vs)) { out.avisos.push(`Linha ignorada (formato inesperado): ${t.slice(0, 80)}`); continue; }
      let valor = dinheiro(valorTxt);
      if (vc && valor < 0) valor = -valor; // crédito sempre positivo
      if (vd && valor > 0) valor = -valor; // débito sempre negativo
      out.lancamentos.push({ data: iso(data.s.trim()), descricao: txt(desc), documento: txt(docs), valor, saldo: dinheiro(vs) });
    }
  }

  const cab = textoCab.join(' | ');
  const per = cab.match(/Período (\d{2}\/\d{2}\/\d{4}) a (\d{2}\/\d{2}\/\d{4})/);
  if (per) { out.periodoIni = iso(per[1]); out.periodoFim = iso(per[2]); }
  out.nome = cab.match(/Nome: (.+?)(?: \||$)/)?.[1]?.trim();
  out.agencia = cab.match(/Ag[êe]ncia: ([\d-]+)/)?.[1];
  out.conta = cab.match(/Conta: ([\d-]+)/)?.[1];
  if (/Banco: (\d+)/.test(cab) && cab.match(/Banco: (\d+)/)![1] !== '085') out.avisos.push('Este extrato é de um banco cujo formato ainda não é lido pelo sistema; confira os lançamentos.');
  if (!out.lancamentos.length) throw new ErroNegocio('Nenhum lançamento encontrado no PDF. Este modelo de extrato ainda não é reconhecido pelo sistema.');

  // conferência: o saldo precisa fechar linha a linha e bater com a linha TOTAL do banco
  let ant = out.saldoAnterior;
  let quebras = 0;
  for (const l of out.lancamentos) { if (ant != null && Math.abs(r2(ant + l.valor) - l.saldo) > 0.005) quebras++; ant = l.saldo; }
  out.saldoFinal = out.lancamentos.at(-1)!.saldo;
  if (quebras) out.avisos.push(`${quebras} lançamento(s) com saldo que não fecha com o anterior — confira o PDF.`);
  if (totais) {
    out.totalCredito = totais[0]; out.totalDebito = totais[1];
    const c = r2(out.lancamentos.filter((l) => l.valor > 0).reduce((s, l) => s + l.valor, 0));
    const d = r2(out.lancamentos.filter((l) => l.valor < 0).reduce((s, l) => s + l.valor, 0));
    if (Math.abs(c - totais[0]) > 0.005 || Math.abs(d - totais[1]) > 0.005) out.avisos.push(`Totais lidos (crédito ${c}, débito ${d}) diferem do total do banco (${totais[0]} / ${totais[1]}).`);
  } else out.avisos.push('O PDF não trouxe a linha de total; a conferência dos valores ficou só pelo saldo.');
  return out;
}

// ---------------------------------------------------------------------------
// Classificação automática
// ---------------------------------------------------------------------------
export const CATEGORIAS_ENTRADA = ['Receita de serviços', 'Outras receitas', 'Estornos e devoluções', 'Empréstimos obtidos', 'Aporte dos sócios'];
const CATEGORIAS_SAIDA_EXTRA = ['Tarifas e juros', 'Empréstimos e financiamentos', 'Retiradas dos sócios', 'Fornecedores', 'Cartão de crédito', 'Seguros', 'Transferências'];

/** Descrição sem números/pontuação, para reconhecer lançamentos parecidos (ex.: o mesmo PIX para a mesma pessoa). */
export const chaveDescricao = (d: string) => d.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\d./:-]+/g, ' ').replace(/\s+/g, ' ').trim();

const REGRAS_PADRAO: [RegExp, string][] = [
  [/DEV\.?\s?COBRANCA|ESTORNO|DEVOLUCAO/, 'Estornos e devoluções'],
  [/CRED\.?\s?COBR|CREDITO TED|CREDITO PIX|CREDITO DOC|CRED\.? ?PIX/, 'Receita de serviços'],
  [/^IOF|^JUROS|^TARIFA|^LIQ\.? ?COB|PIX TRANSF PAGADOR|MANUT.*CONTA|ANUIDADE|^CESTA/, 'Tarifas e juros'],
  [/FOLHA DE PAGT|FERIAS|RESCISAO|ADIANTAMENTO|AUX TRANSPORTE|13[ºo] SAL/, 'Salários e encargos'],
  [/\bDARF\b|\bDAS\b|\bIRPJ\b|\bCSLL\b|\bPIS\b|\bCOFINS\b|\bFGTS\b|\bGPS\b|\bINSS\b|\bISS\b|\bICMS\b/, 'Impostos e taxas'],
  [/EMPREST|PARC\.? EMP/, 'Empréstimos e financiamentos'],
  [/CELESC|CASAN|CPFL|COPEL|ENERGISA|SANEPAR|\bVIVO\b|CLASSISUL|\bTIM\b/, 'Água, luz e internet'],
  [/FATURA CARTAO/, 'Cartão de crédito'],
  [/SEGUROS|ICATU|PORTO SEGURO/, 'Seguros'],
  [/SAQUE CARTAO/, 'Retiradas dos sócios'],
];

function categoriaAutomatica(empresaId: number, descricao: string, valor: number): { categoria: string; origem: 'regra' | 'auto' } | null {
  const k = chaveDescricao(descricao);
  const aprendida = db.prepare('SELECT categoria FROM extrato_regras WHERE empresa_id = ? AND chave = ?').get(empresaId, k) as { categoria: string } | undefined;
  if (aprendida) return { categoria: aprendida.categoria, origem: 'regra' };
  const d = descricao.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, cat] of REGRAS_PADRAO) {
    if (!re.test(d)) continue;
    const entrada = CATEGORIAS_ENTRADA.includes(cat);
    if (entrada !== valor > 0) continue; // categoria de entrada só vale para crédito e vice-versa
    return { categoria: cat, origem: 'auto' };
  }
  return null;
}

export function categoriasDoExtrato(empresaId: number) {
  const usadas = db.prepare('SELECT DISTINCT categoria, valor > 0 AS entrada FROM extrato_lancamentos WHERE empresa_id = ? AND categoria IS NOT NULL').all(empresaId) as { categoria: string; entrada: number }[];
  const unico = (l: string[]) => [...new Set(l)];
  return {
    entradas: unico([...CATEGORIAS_ENTRADA, ...usadas.filter((u) => u.entrada).map((u) => u.categoria)]),
    saidas: unico([...listarCategorias(empresaId), ...CATEGORIAS_SAIDA_EXTRA, ...usadas.filter((u) => !u.entrada).map((u) => u.categoria)]),
  };
}

// ---------------------------------------------------------------------------
// Importação e conciliação com os boletos
// ---------------------------------------------------------------------------
export async function importarExtrato(empresaId: number, nomeArquivo: string, pdf: Buffer) {
  const lido = await lerPdfExtrato(pdf);
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  if (db.prepare('SELECT 1 FROM extrato_importacoes WHERE empresa_id = ? AND hash = ?').get(empresaId, hash)) throw new ErroNegocio('Este arquivo já foi importado.');
  const conta = db.prepare('SELECT conta, conta_dv FROM contas_bancarias WHERE empresa_id = ?').get(empresaId) as any;
  const avisos = [...lido.avisos];
  const digitos = (s?: string) => (s ?? '').replace(/\D/g, '');
  if (conta && lido.conta && !digitos(conta.conta + conta.conta_dv).includes(digitos(lido.conta)) && !digitos(lido.conta).includes(digitos(conta.conta))) {
    avisos.push(`A conta do extrato (${lido.conta}) é diferente da conta cadastrada em Dados bancários (${conta.conta}-${conta.conta_dv}). Confira se escolheu a empresa certa.`);
  }

  return db.transaction(() => {
    const imp = Number(db.prepare(`INSERT INTO extrato_importacoes (empresa_id, arquivo, hash, periodo_ini, periodo_fim, saldo_anterior, saldo_final, qtd, conta)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(empresaId, nomeArquivo.slice(0, 120), hash, lido.periodoIni ?? null, lido.periodoFim ?? null, lido.saldoAnterior ?? null, lido.saldoFinal ?? null, lido.lancamentos.length, lido.conta ?? null).lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO extrato_lancamentos (empresa_id, importacao_id, data, descricao, documento, valor, saldo, categoria, categoria_origem, chave)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let novos = 0;
    for (const l of lido.lancamentos) {
      const chave = crypto.createHash('sha1').update(`${l.data}|${l.descricao}|${l.documento}|${l.valor}|${l.saldo}`).digest('hex');
      const c = categoriaAutomatica(empresaId, l.descricao, l.valor);
      novos += Number(ins.run(empresaId, imp, l.data, l.descricao, l.documento, l.valor, l.saldo, c?.categoria ?? null, c?.origem ?? null, chave).changes);
    }
    const conciliados = conciliarAutomatico(empresaId);
    sincronizarDespesasDoExtrato(empresaId);
    return { importacaoId: imp, lidos: lido.lancamentos.length, novos, repetidos: lido.lancamentos.length - novos, conciliados, periodo: [lido.periodoIni, lido.periodoFim], avisos };
  })();
}

/** Grava lançamentos que não vêm de PDF (ex.: API do banco), com a mesma categorização e conciliação da importação. */
export function importarLancamentosExternos(empresaId: number, d: {
  arquivo: string; hash: string; periodoIni?: string; periodoFim?: string; saldoAnterior?: number | null; saldoFinal?: number | null; conta?: string;
  lancamentos: { data: string; descricao: string; documento: string; valor: number; saldo: number | null; chave: string }[];
}) {
  return db.transaction(() => {
    let imp = (db.prepare('SELECT id FROM extrato_importacoes WHERE empresa_id = ? AND hash = ?').get(empresaId, d.hash) as any)?.id as number | undefined;
    if (!imp) {
      imp = Number(db.prepare(`INSERT INTO extrato_importacoes (empresa_id, arquivo, hash, periodo_ini, periodo_fim, saldo_anterior, saldo_final, qtd, conta)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(empresaId, d.arquivo.slice(0, 120), d.hash, d.periodoIni ?? null, d.periodoFim ?? null, d.saldoAnterior ?? null, d.saldoFinal ?? null, d.lancamentos.length, d.conta ?? null).lastInsertRowid);
    }
    const ins = db.prepare(`INSERT OR IGNORE INTO extrato_lancamentos (empresa_id, importacao_id, data, descricao, documento, valor, saldo, categoria, categoria_origem, chave)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let novos = 0;
    for (const l of d.lancamentos) {
      const c = categoriaAutomatica(empresaId, l.descricao, l.valor);
      novos += Number(ins.run(empresaId, imp, l.data, l.descricao, l.documento, l.valor, l.saldo, c?.categoria ?? null, c?.origem ?? null, l.chave).changes);
    }
    const conciliados = conciliarAutomatico(empresaId);
    sincronizarDespesasDoExtrato(empresaId);
    return { importacaoId: imp, novos, conciliados };
  })();
}

/** Boletos que podem corresponder a um crédito: mesmo valor e data de pagamento/vencimento próxima. */
export function candidatosBoleto(empresaId: number, lancId: number) {
  const l = db.prepare('SELECT * FROM extrato_lancamentos WHERE id = ? AND empresa_id = ?').get(lancId, empresaId) as any;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  if (l.valor <= 0) return [];
  return db.prepare(`SELECT c.id, c.valor, c.valor_pago, c.vencimento, c.pago_em, c.status, t.nome AS tomador, c.descricao
      FROM cobrancas c JOIN tomadores t ON t.id = c.tomador_id
      WHERE c.empresa_id = ? AND c.status IN ('PAGO','REGISTRADO','REMETIDO','A_REMETER','AGUARDANDO_BANCO')
        AND ABS(COALESCE(c.valor_pago, c.valor) - ?) < 0.005
        AND ABS(julianday(COALESCE(c.pago_em, c.vencimento)) - julianday(?)) <= 10
        AND NOT EXISTS (SELECT 1 FROM extrato_lancamentos x WHERE x.cobranca_id = c.id AND x.id <> ?)
      ORDER BY ABS(julianday(COALESCE(c.pago_em, c.vencimento)) - julianday(?)) LIMIT 8`).all(empresaId, l.valor, l.data, lancId, l.data);
}

/** Vincula sozinho quando existe um único boleto compatível com o crédito. */
export function conciliarAutomatico(empresaId: number): number {
  const cred = db.prepare("SELECT id FROM extrato_lancamentos WHERE empresa_id = ? AND valor > 0 AND cobranca_id IS NULL AND categoria_origem IS NOT 'manual' AND descricao NOT LIKE 'DEV%'").all(empresaId) as { id: number }[];
  let n = 0;
  for (const { id } of cred) {
    const c = candidatosBoleto(empresaId, id);
    if (c.length !== 1) continue;
    db.prepare("UPDATE extrato_lancamentos SET cobranca_id = ?, categoria = COALESCE(categoria, 'Receita de serviços'), categoria_origem = COALESCE(categoria_origem, 'auto') WHERE id = ?").run(c[0].id, id);
    n++;
  }
  return n;
}

export function conciliar(empresaId: number, lancId: number, cobrancaId: number | null, darBaixa: boolean) {
  const l = db.prepare('SELECT * FROM extrato_lancamentos WHERE id = ? AND empresa_id = ?').get(lancId, empresaId) as any;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  if (cobrancaId == null) { db.prepare('UPDATE extrato_lancamentos SET cobranca_id = NULL WHERE id = ?').run(lancId); return; }
  if (l.valor <= 0) throw new ErroNegocio('Só entradas podem ser ligadas a um boleto.');
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ? AND empresa_id = ?').get(cobrancaId, empresaId) as any;
  if (!c) throw new ErroNegocio('Boleto não encontrado.', 404);
  if (db.prepare('SELECT 1 FROM extrato_lancamentos WHERE cobranca_id = ? AND id <> ?').get(cobrancaId, lancId)) throw new ErroNegocio('Este boleto já está ligado a outro lançamento.');
  db.transaction(() => {
    if (darBaixa && c.status !== 'PAGO' && c.status !== 'CANCELADO') marcarPago(cobrancaId, l.data, l.valor);
    db.prepare("UPDATE extrato_lancamentos SET cobranca_id = ?, categoria = 'Receita de serviços', categoria_origem = 'manual' WHERE id = ?").run(cobrancaId, lancId);
  })();
}

export const Classificacao = z.object({ categoria: z.string().trim().min(1, 'Informe a categoria').max(60).nullable(), aplicarSemelhantes: z.boolean().default(false) });

export function classificar(empresaId: number, lancId: number, d: z.infer<typeof Classificacao>) {
  const l = db.prepare('SELECT * FROM extrato_lancamentos WHERE id = ? AND empresa_id = ?').get(lancId, empresaId) as any;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  const origem = d.categoria ? 'manual' : null;
  db.transaction(() => {
    db.prepare('UPDATE extrato_lancamentos SET categoria = ?, categoria_origem = ? WHERE id = ?').run(d.categoria, origem, lancId);
    if (!d.aplicarSemelhantes) return;
    const k = chaveDescricao(l.descricao);
    if (d.categoria) db.prepare('INSERT INTO extrato_regras (empresa_id, chave, categoria) VALUES (?,?,?) ON CONFLICT(empresa_id, chave) DO UPDATE SET categoria = excluded.categoria').run(empresaId, k, d.categoria);
    else db.prepare('DELETE FROM extrato_regras WHERE empresa_id = ? AND chave = ?').run(empresaId, k);
    const sinal = l.valor > 0 ? '>' : '<';
    const outros = db.prepare(`SELECT id, descricao FROM extrato_lancamentos WHERE empresa_id = ? AND id <> ? AND valor ${sinal} 0 AND categoria_origem IS NOT 'manual'`).all(empresaId, lancId) as any[];
    for (const o of outros) if (chaveDescricao(o.descricao) === k) db.prepare('UPDATE extrato_lancamentos SET categoria = ?, categoria_origem = ? WHERE id = ?').run(d.categoria, d.categoria ? 'regra' : null, o.id);
  })();
  sincronizarDespesasDoExtrato(empresaId);
}

// ---------------------------------------------------------------------------
// Consultas: lista do mês, balanço e exclusão
// ---------------------------------------------------------------------------
export function extratoDoMes(empresaId: number, mes: string) {
  const lancs = db.prepare(`SELECT x.id, x.data, x.descricao, x.documento, x.valor, x.saldo, x.categoria, x.categoria_origem, x.cobranca_id,
      t.nome AS tomador, c.vencimento AS boleto_venc, dl.id AS despesa_ligada_id, dl.descricao AS despesa_ligada
    FROM extrato_lancamentos x LEFT JOIN despesas dl ON dl.extrato_lancamento_id = x.id AND dl.origem <> 'EXTRATO' LEFT JOIN cobrancas c ON c.id = x.cobranca_id LEFT JOIN tomadores t ON t.id = c.tomador_id
    WHERE x.empresa_id = ? AND substr(x.data,1,7) = ? ORDER BY x.data, x.id`).all(empresaId, mes) as any[];
  const entradas = r2(lancs.filter((l) => l.valor > 0).reduce((s, l) => s + l.valor, 0));
  const saidas = r2(-lancs.filter((l) => l.valor < 0).reduce((s, l) => s + l.valor, 0));
  return {
    mes, lancamentos: lancs, entradas, saidas, resultado: r2(entradas - saidas),
    semClassificacao: lancs.filter((l) => !l.categoria).length,
    importacoes: db.prepare('SELECT id, arquivo, periodo_ini, periodo_fim, qtd, criado_em FROM extrato_importacoes WHERE empresa_id = ? ORDER BY periodo_ini DESC, id DESC').all(empresaId),
    meses: (db.prepare('SELECT DISTINCT substr(data,1,7) AS m FROM extrato_lancamentos WHERE empresa_id = ? ORDER BY m DESC').all(empresaId) as { m: string }[]).map((x) => x.m),
    categorias: categoriasDoExtrato(empresaId),
  };
}

/** Balanço financeiro por categoria no período (entradas e saídas classificadas). */
export function balancoExtrato(empresaId: number, de: string, ate: string) {
  const l = db.prepare('SELECT categoria, valor FROM extrato_lancamentos WHERE empresa_id = ? AND data BETWEEN ? AND ?').all(empresaId, de, ate) as { categoria: string | null; valor: number }[];
  const agrupar = (sinal: 1 | -1) => {
    const m = new Map<string, number>();
    for (const x of l.filter((y) => Math.sign(y.valor) === sinal)) m.set(x.categoria ?? 'Sem classificação', r2((m.get(x.categoria ?? 'Sem classificação') ?? 0) + Math.abs(x.valor)));
    return [...m.entries()].map(([categoria, total]) => ({ categoria, total })).sort((a, b) => b.total - a.total);
  };
  const entradas = agrupar(1), saidas = agrupar(-1);
  const te = r2(entradas.reduce((s, x) => s + x.total, 0)), ts = r2(saidas.reduce((s, x) => s + x.total, 0));
  return { de, ate, entradas, saidas, totalEntradas: te, totalSaidas: ts, resultado: r2(te - ts), semClassificacao: l.filter((x) => !x.categoria).length };
}

export function excluirImportacao(empresaId: number, id: number) {
  if (!db.prepare('SELECT 1 FROM extrato_importacoes WHERE id = ? AND empresa_id = ?').get(id, empresaId)) throw new ErroNegocio('Importação não encontrada.', 404);
  db.transaction(() => {
    db.prepare("DELETE FROM despesas WHERE empresa_id = ? AND origem = 'EXTRATO' AND extrato_lancamento_id IN (SELECT id FROM extrato_lancamentos WHERE importacao_id = ?)").run(empresaId, id);
    db.prepare('DELETE FROM extrato_lancamentos WHERE empresa_id = ? AND importacao_id = ?').run(empresaId, id);
    db.prepare('DELETE FROM extrato_importacoes WHERE id = ? AND empresa_id = ?').run(id, empresaId);
  })();
}


// ---------------------------------------------------------------------------
// Espelho em Despesas e balanço: toda saída classificada do extrato vira uma despesa (origem EXTRATO)
// ---------------------------------------------------------------------------
/** Categorias de saída que não são despesa: a fatura do cartão (os gastos entram pela própria fatura) e transferências. */
const NAO_E_DESPESA = new Set(['Cartão de crédito', 'Transferências']);

function formaDoLancamento(descricao: string): 'PIX' | 'DEBITO' | 'CREDITO' | null {
  const d = descricao.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\bPIX\b/.test(d)) return 'PIX';
  if (/CARTAO|\bDEB\b|DEBITO|COMPRA/.test(d)) return 'DEBITO';
  return null;
}

/** Cria, atualiza ou remove as despesas espelho. Despesas manuais já ligadas ao lançamento (justificativa) dispensam o espelho. */
export function sincronizarDespesasDoExtrato(empresaId: number) {
  {
    const lancs = db.prepare('SELECT id, data, descricao, valor, categoria FROM extrato_lancamentos WHERE empresa_id = ? AND valor < 0').all(empresaId) as any[];
    const espelhos = new Map((db.prepare("SELECT id, extrato_lancamento_id AS lid FROM despesas WHERE empresa_id = ? AND origem = 'EXTRATO'").all(empresaId) as any[]).map((x) => [x.lid, x.id]));
    const ligadasManual = new Set((db.prepare("SELECT extrato_lancamento_id AS lid FROM despesas WHERE empresa_id = ? AND origem <> 'EXTRATO' AND extrato_lancamento_id IS NOT NULL").all(empresaId) as any[]).map((x) => x.lid));
    const ins = db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, forma_pagamento, origem, extrato_lancamento_id) VALUES (?,?,?,?,?,?,'EXTRATO',?)");
    const upd = db.prepare('UPDATE despesas SET data = ?, categoria = ?, descricao = ?, valor = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM despesas WHERE id = ?');
    const vivos = new Set<number>();
    for (const l of lancs) {
      if (!l.categoria || NAO_E_DESPESA.has(l.categoria) || ligadasManual.has(l.id)) continue;
      vivos.add(l.id);
      const val = Math.round(-l.valor * 100) / 100;
      const ex = espelhos.get(l.id);
      if (ex) upd.run(l.data, l.categoria, l.descricao.slice(0, 200), val, ex);
      else ins.run(empresaId, l.data, l.categoria, l.descricao.slice(0, 200), val, formaDoLancamento(l.descricao), l.id);
    }
    for (const [lid, did] of espelhos) if (!vivos.has(lid)) del.run(did);
  }
}


// ---------------------------------------------------------------------------
// Vínculo de uma saída do extrato com uma despesa lançada à mão (por exemplo, a parcela de uma compra)
// ---------------------------------------------------------------------------
/** Despesas manuais ainda sem extrato, com o mesmo valor da saída e data até 45 dias de distância. */
export function candidatosDespesa(empresaId: number, lancId: number) {
  const l = db.prepare('SELECT data, valor FROM extrato_lancamentos WHERE id = ? AND empresa_id = ?').get(lancId, empresaId) as { data: string; valor: number } | undefined;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  if (l.valor >= 0) throw new ErroNegocio('Só saídas do extrato podem ser ligadas a despesas.');
  return db.prepare(`SELECT id, data, categoria, descricao, valor FROM despesas
    WHERE empresa_id = ? AND origem = 'MANUAL' AND extrato_lancamento_id IS NULL AND ABS(valor - ?) < 0.005
      AND ABS(julianday(data) - julianday(?)) <= 45 ORDER BY ABS(julianday(data) - julianday(?)), id`).all(empresaId, -l.valor, l.data, l.data);
}

/** Liga (ou, com despesaId nulo, desfaz) o vínculo. A despesa ligada substitui o espelho do extrato, sem contar duas vezes. */
export function ligarDespesa(empresaId: number, lancId: number, despesaId: number | null) {
  const l = db.prepare('SELECT valor, categoria FROM extrato_lancamentos WHERE id = ? AND empresa_id = ?').get(lancId, empresaId) as { valor: number; categoria: string | null } | undefined;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  db.transaction(() => {
    if (despesaId === null) {
      db.prepare("UPDATE despesas SET extrato_lancamento_id = NULL WHERE empresa_id = ? AND origem = 'MANUAL' AND extrato_lancamento_id = ?").run(empresaId, lancId);
    } else {
      if (l.valor >= 0) throw new ErroNegocio('Só saídas do extrato podem ser ligadas a despesas.');
      const d = db.prepare('SELECT origem, valor, categoria, extrato_lancamento_id AS lid FROM despesas WHERE id = ? AND empresa_id = ?').get(despesaId, empresaId) as any;
      if (!d) throw new ErroNegocio('Despesa não encontrada.', 404);
      if (d.origem !== 'MANUAL') throw new ErroNegocio('Só despesas lançadas à mão (ou parcelas de compras) podem ser ligadas.');
      if (d.lid && d.lid !== lancId) throw new ErroNegocio('Esta despesa já está ligada a outro lançamento do extrato.');
      if (Math.abs(d.valor + l.valor) > 0.005) throw new ErroNegocio('O valor da despesa é diferente do valor da saída no extrato.');
      db.prepare("DELETE FROM despesas WHERE empresa_id = ? AND origem = 'EXTRATO' AND extrato_lancamento_id = ?").run(empresaId, lancId);
      db.prepare("UPDATE despesas SET extrato_lancamento_id = NULL WHERE empresa_id = ? AND origem = 'MANUAL' AND extrato_lancamento_id = ?").run(empresaId, lancId);
      db.prepare('UPDATE despesas SET extrato_lancamento_id = ? WHERE id = ?').run(lancId, despesaId);
      if (!l.categoria) db.prepare("UPDATE extrato_lancamentos SET categoria = ?, categoria_origem = 'manual' WHERE id = ?").run(d.categoria, lancId);
    }
    sincronizarDespesasDoExtrato(empresaId);
  })();
}
