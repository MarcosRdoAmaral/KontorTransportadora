import PDFDocument from 'pdfkit';
import { db } from '../db.js';
import { lerNfse } from '../nfse/leitura.js';
import { ErroNegocio } from './emissao.js';
import { balancoExtrato } from './extrato.js';
import { despesaMes, recebidoMes } from './financeiro.js';
import { COR, MM, cabecalho, docFmt, rodapes, type Emitente } from '../pdf/timbrado.js';

/**
 * Relatórios gerenciais. A nota e o boleto têm datas próprias (emissão da nota, emissão do boleto, vencimento,
 * pagamento), então cada relatório diz qual data filtra e as demais aparecem como colunas.
 */
export type TipoColuna = 'texto' | 'data' | 'moeda' | 'inteiro';
export interface Coluna { k: string; nome: string; tipo: TipoColuna; soma?: boolean }
export interface Relatorio { id: string; titulo: string; descricao: string; filtroData: string; colunas: Coluna[]; linhas: Record<string, any>[]; totais: Record<string, number>; subtitulo: string }
export interface Filtros { de: string; ate: string; tomadorId?: number | null; situacao?: string | null }

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dias = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

/** Um título = boleto, com os dados da nota a que pertence (quando houver). */
function titulos(empresaId: number, tomadorId?: number | null) {
  const hoje = hojeBr();
  const l = db.prepare(`SELECT c.id, c.vencimento, c.valor, c.valor_pago, c.pago_em, c.status AS st, c.descricao, c.desconto, c.forma,
      COALESCE(c.emissao, substr(c.criado_em,1,10)) AS emissao_boleto, t.id AS tomador_id, t.nome AS cliente,
      n.id AS nota_id, n.n_nfse, n.valor_servico, n.status AS nota_status,
      COALESCE(date(n.autorizada_em, '-3 hours'), date(n.criado_em, '-3 hours')) AS emissao_nota
    FROM cobrancas c JOIN tomadores t ON t.id = c.tomador_id LEFT JOIN notas n ON n.id = c.nota_id
    WHERE c.empresa_id = ? AND c.status <> 'CANCELADO' ${tomadorId ? 'AND c.tomador_id = ?' : ''} ORDER BY c.vencimento, t.nome`).all(...(tomadorId ? [empresaId, tomadorId] : [empresaId])) as any[];
  return l.map((x) => ({
    ...x,
    emissao: x.emissao_nota ?? x.emissao_boleto,
    situacao: x.st === 'PAGO' ? 'Pago' : x.vencimento < hoje ? 'Vencido' : 'A vencer',
    atraso: x.st === 'PAGO' ? Math.max(0, dias(x.pago_em ?? x.vencimento, x.vencimento)) : Math.max(0, dias(hoje, x.vencimento)),
  }));
}
const entre = (d: string | null | undefined, f: Filtros) => !!d && d.slice(0, 10) >= f.de && d.slice(0, 10) <= f.ate;
const soma = (l: any[], k: string) => r2(l.reduce((t, x) => t + (Number(x[k]) || 0), 0));

const FORMA: Record<string, string> = { PIX: 'PIX', DEBITO: 'Débito', CREDITO: 'Crédito', DINHEIRO: 'Dinheiro' };
const ORIGEM: Record<string, string> = { MANUAL: 'Lançamento manual', EXTRATO: 'Extrato bancário', CARTAO: 'Fatura do cartão' };

const COL = {
  emissao: { k: 'emissao', nome: 'Emissão', tipo: 'data' }, vencimento: { k: 'vencimento', nome: 'Vencimento', tipo: 'data' },
  cliente: { k: 'cliente', nome: 'Cliente', tipo: 'texto' }, nota: { k: 'n_nfse', nome: 'Nota', tipo: 'texto' },
  valorNota: { k: 'valor_servico', nome: 'Valor da nota', tipo: 'moeda', soma: true }, valorBoleto: { k: 'valor', nome: 'Valor do boleto', tipo: 'moeda', soma: true },
  situacao: { k: 'situacao', nome: 'Situação', tipo: 'texto' }, pagoEm: { k: 'pago_em', nome: 'Pago em', tipo: 'data' },
  atraso: { k: 'atraso', nome: 'Dias de atraso', tipo: 'inteiro' },
} as const satisfies Record<string, Coluna>;

/** Ordem em que os grupos aparecem na tela. */
export const GRUPOS = ['Faturamento', 'Contas a receber', 'Despesas e pagamentos', 'Fiscal e retenções', 'Resultado e caixa', 'Clientes'] as const;
export type Grupo = (typeof GRUPOS)[number];
interface Def { grupo: Grupo; titulo: string; descricao: string; filtroData: string; situacoes?: string[]; gerar: (empresaId: number, f: Filtros) => { colunas: Coluna[]; linhas: any[] } }

export const RELATORIOS: Record<string, Def> = {
  'receitas-emitidas': {
    grupo: 'Faturamento',
    titulo: 'Receitas emitidas', filtroData: 'Data de emissão (da nota; do boleto quando não há nota)',
    descricao: 'Tudo o que foi faturado no período, com a data da nota e o vencimento do boleto lado a lado.',
    gerar: (e, f) => {
      const t = titulos(e, f.tomadorId).filter((x) => entre(x.emissao, f));
      const semBoleto = db.prepare(`SELECT n.n_nfse, n.valor_servico, n.tomador_nome AS cliente, COALESCE(date(n.autorizada_em,'-3 hours'), date(n.criado_em,'-3 hours')) AS emissao
        FROM notas n WHERE n.empresa_id = ? AND n.status = 'AUTORIZADA' ${f.tomadorId ? 'AND n.tomador_id = ' + Number(f.tomadorId) : ''}
        AND NOT EXISTS (SELECT 1 FROM cobrancas c WHERE c.nota_id = n.id AND c.status <> 'CANCELADO')`).all(e) as any[];
      const linhas = [...t, ...semBoleto.filter((x) => entre(x.emissao, f)).map((x) => ({ ...x, situacao: 'Sem boleto' }))].sort((a, b) => a.emissao.localeCompare(b.emissao));
      return { colunas: [COL.emissao, COL.nota, COL.cliente, COL.valorNota, COL.vencimento, COL.valorBoleto, COL.situacao, COL.pagoEm], linhas };
    },
  },
  'a-receber': {
    grupo: 'Contas a receber',
    titulo: 'Contas a receber por vencimento', filtroData: 'Vencimento do boleto', situacoes: ['Vencido', 'A vencer'],
    descricao: 'Boletos em aberto no período de vencimento, separados em vencidos e a vencer, com a data de emissão da nota.',
    gerar: (e, f) => ({
      colunas: [COL.vencimento, COL.cliente, COL.nota, COL.emissao, COL.valorBoleto, COL.atraso, COL.situacao],
      linhas: titulos(e, f.tomadorId).filter((x) => x.st !== 'PAGO' && entre(x.vencimento, f) && (!f.situacao || x.situacao === f.situacao)),
    }),
  },
  'em-aberto-emissao': {
    grupo: 'Contas a receber',
    titulo: 'Em aberto por data de emissão', filtroData: 'Data de emissão da nota/boleto', situacoes: ['Vencido', 'A vencer'],
    descricao: 'O que foi emitido no período e ainda não foi pago, mesmo que o vencimento seja em outro mês.',
    gerar: (e, f) => ({
      colunas: [COL.emissao, COL.cliente, COL.nota, COL.vencimento, COL.valorBoleto, COL.atraso, COL.situacao],
      linhas: titulos(e, f.tomadorId).filter((x) => x.st !== 'PAGO' && entre(x.emissao, f) && (!f.situacao || x.situacao === f.situacao)).sort((a, b) => a.emissao.localeCompare(b.emissao)),
    }),
  },
  recebimentos: {
    grupo: 'Contas a receber',
    titulo: 'Recebimentos', filtroData: 'Data do pagamento',
    descricao: 'Boletos pagos no período, com vencimento, valor pago e dias de atraso.',
    gerar: (e, f) => ({
      colunas: [COL.pagoEm, COL.cliente, COL.nota, COL.vencimento, COL.valorBoleto, { k: 'valor_pago', nome: 'Valor pago', tipo: 'moeda', soma: true }, COL.atraso],
      linhas: titulos(e, f.tomadorId).filter((x) => x.st === 'PAGO' && entre(x.pago_em, f)).sort((a, b) => (a.pago_em ?? '').localeCompare(b.pago_em ?? '')).map((x) => ({ ...x, valor_pago: x.valor_pago ?? x.valor })),
    }),
  },
  'a-receber-carteira': {
    grupo: 'Contas a receber',
    titulo: 'Contas a receber por carteira', filtroData: 'Vencimento do boleto/Pix', situacoes: ['Vencido', 'A vencer'],
    descricao: 'Cobranças em aberto separadas pela carteira (boleto bancário ou Pix copia e cola), com subtotal de cada uma. Mostra também as cobranças Pix que ainda esperam o código.',
    gerar: (e, f) => {
      const l = titulos(e, f.tomadorId).filter((x) => x.st !== 'PAGO' && entre(x.vencimento, f) && (!f.situacao || x.situacao === f.situacao));
      const linhas: any[] = [];
      for (const [forma, nome] of [['BOLETO', 'Boleto bancário'], ['PIX', 'Pix copia e cola']] as const) {
        const g = l.filter((x) => (x.forma ?? 'BOLETO') === forma);
        if (!g.length) continue;
        linhas.push(...g.map((x) => ({ ...x, carteira: nome, situacao: forma === 'PIX' && x.st === 'AGUARDANDO_BANCO' ? `${x.situacao} · sem Pix` : x.situacao })));
        linhas.push({ carteira: 'Subtotal', cliente: `${nome}: ${g.length} cobrança(s)`, valor_sub: soma(g, 'valor'), _subtotal: true });
      }
      return { colunas: [{ k: 'carteira', nome: 'Carteira', tipo: 'texto' }, COL.vencimento, COL.cliente, COL.nota, COL.valorBoleto, { k: 'valor_sub', nome: 'Subtotal', tipo: 'moeda' }, COL.atraso, COL.situacao], linhas };
    },
  },
  'saldo-vencido': {
    grupo: 'Contas a receber',
    titulo: 'Saldo vencido por cliente', filtroData: 'Posição na data final (títulos vencidos até ela)',
    descricao: 'Quanto cada cliente deve em atraso, por faixa de dias.',
    gerar: (e, f) => {
      const por = new Map<string, any>();
      for (const x of titulos(e, f.tomadorId).filter((x) => x.st !== 'PAGO' && x.vencimento < f.ate)) {
        const d = dias(f.ate, x.vencimento);
        const r = por.get(x.cliente) ?? { cliente: x.cliente, f1: 0, f2: 0, f3: 0, f4: 0, total: 0, titulos: 0 };
        r[d <= 30 ? 'f1' : d <= 60 ? 'f2' : d <= 90 ? 'f3' : 'f4'] += x.valor; r.total += x.valor; r.titulos++; por.set(x.cliente, r);
      }
      const m = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [COL.cliente, { k: 'titulos', nome: 'Títulos', tipo: 'inteiro', soma: true }, m('f1', 'Até 30 dias'), m('f2', '31 a 60'), m('f3', '61 a 90'), m('f4', 'Mais de 90'), m('total', 'Total vencido')],
        linhas: [...por.values()].sort((a, b) => b.total - a.total) };
    },
  },
  'posicao-clientes': {
    grupo: 'Contas a receber',
    titulo: 'Posição por cliente', filtroData: 'Emissão da nota/boleto no período',
    descricao: 'Para cada cliente: quanto foi faturado, recebido, está a vencer e vencido.',
    gerar: (e, f) => {
      const por = new Map<string, any>();
      for (const x of titulos(e, f.tomadorId).filter((x) => entre(x.emissao, f))) {
        const r = por.get(x.cliente) ?? { cliente: x.cliente, qtd: 0, faturado: 0, recebido: 0, a_vencer: 0, vencido: 0 };
        r.qtd++; r.faturado += x.valor;
        if (x.st === 'PAGO') r.recebido += x.valor_pago ?? x.valor; else if (x.situacao === 'Vencido') r.vencido += x.valor; else r.a_vencer += x.valor;
        por.set(x.cliente, r);
      }
      const m = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [COL.cliente, { k: 'qtd', nome: 'Boletos', tipo: 'inteiro', soma: true }, m('faturado', 'Faturado'), m('recebido', 'Recebido'), m('a_vencer', 'A vencer'), m('vencido', 'Vencido')], linhas: [...por.values()].sort((a, b) => b.faturado - a.faturado) };
    },
  },
  'faturamento-cidade': {
    grupo: 'Faturamento',
    titulo: 'Faturamento por cidade/UF', filtroData: 'Data de emissão da nota',
    descricao: 'Notas autorizadas no período agrupadas pela cidade e UF do cliente, com quantidade de clientes, de notas e participação no total. Ajuda a ver onde está o faturamento e a conferir o ISS de outros municípios.',
    gerar: (e, f) => {
      const l = db.prepare(`SELECT COALESCE(NULLIF(t.cidade,''), '(sem cidade no cadastro)') AS cidade, COALESCE(NULLIF(t.uf,''), '—') AS uf, COUNT(DISTINCT COALESCE(n.tomador_id, n.tomador_nome)) AS clientes,
          COUNT(*) AS notas, SUM(n.valor_servico) AS valor FROM notas n LEFT JOIN tomadores t ON t.id = n.tomador_id
        WHERE n.empresa_id = ? AND n.status = 'AUTORIZADA' ${f.tomadorId ? 'AND n.tomador_id = ' + Number(f.tomadorId) : ''} AND COALESCE(date(n.autorizada_em,'-3 hours'), date(n.criado_em,'-3 hours')) BETWEEN ? AND ?
        GROUP BY 1, 2 ORDER BY valor DESC`).all(e, f.de, f.ate) as any[];
      const t = soma(l, 'valor') || 1;
      return { colunas: [{ k: 'uf', nome: 'UF', tipo: 'texto' }, { k: 'cidade', nome: 'Cidade', tipo: 'texto' }, { k: 'clientes', nome: 'Clientes', tipo: 'inteiro', soma: true }, { k: 'notas', nome: 'Notas', tipo: 'inteiro', soma: true }, { k: 'valor', nome: 'Faturado', tipo: 'moeda', soma: true }, { k: 'pct', nome: '% do total', tipo: 'inteiro' }],
        linhas: l.map((x) => ({ ...x, valor: r2(x.valor), pct: Math.round((x.valor / t) * 100) })) };
    },
  },
  'notas-emitidas': {
    grupo: 'Fiscal e retenções',
    titulo: 'Notas emitidas e tributos', filtroData: 'Data de emissão da nota',
    descricao: 'Notas autorizadas no período com ISS, retenções federais e valor líquido, lidos do XML.',
    gerar: (e, f) => {
      const notas = db.prepare(`SELECT id, n_nfse, status, xml_nfse, tomador_nome AS cliente, valor_servico, competencia,
          COALESCE(date(autorizada_em,'-3 hours'), date(criado_em,'-3 hours')) AS emissao
        FROM notas WHERE empresa_id = ? AND xml_nfse IS NOT NULL ${f.tomadorId ? 'AND tomador_id = ' + Number(f.tomadorId) : ''} ORDER BY emissao, id LIMIT 5000`).all(e) as any[];
      const linhas = notas.filter((n) => entre(n.emissao, f)).map((n) => {
        let v: any = {}, desc = '';
        try { const l = lerNfse(n.xml_nfse); v = l.valores; desc = l.servico.descricao; } catch { /* XML fora do padrão: mostra só o básico */ }
        const federais = (v.vRetIRRF ?? 0) + (v.vRetCP ?? 0) + (v.vRetCSLL ?? 0) + (v.vPis ?? 0) + (v.vCofins ?? 0);
        return { ...n, situacao: n.status === 'CANCELADA' ? 'Cancelada' : 'Autorizada', servico: desc.slice(0, 60), iss: v.vISSQN ?? 0, retencoes: r2(federais), liquido: v.vLiq ?? n.valor_servico };
      });
      return { colunas: [COL.emissao, COL.nota, COL.cliente, { k: 'servico', nome: 'Serviço', tipo: 'texto' }, COL.valorNota, { k: 'iss', nome: 'ISS', tipo: 'moeda', soma: true },
        { k: 'retencoes', nome: 'Retenções federais', tipo: 'moeda', soma: true }, { k: 'liquido', nome: 'Líquido', tipo: 'moeda', soma: true }, COL.situacao], linhas };
    },
  },
  'compras': {
    grupo: 'Despesas e pagamentos',
    titulo: 'Compras (NF-e de entrada)', filtroData: 'Data de emissão da NF-e',
    descricao: 'Compras lançadas por XML ou manualmente, com o fornecedor, o total e o que foi lançado como despesa.',
    gerar: (e, f) => ({
      colunas: [
        { k: 'emissao', nome: 'Emissão', tipo: 'data' }, { k: 'fornecedor', nome: 'Fornecedor', tipo: 'texto' }, { k: 'documento', nome: 'CNPJ/CPF', tipo: 'texto' },
        { k: 'numero', nome: 'NF', tipo: 'texto' }, { k: 'produtos', nome: 'Produtos', tipo: 'moeda', soma: true }, { k: 'outras', nome: 'Frete e outras', tipo: 'moeda', soma: true },
        { k: 'desconto', nome: 'Desconto', tipo: 'moeda', soma: true }, { k: 'total', nome: 'Total', tipo: 'moeda', soma: true }, { k: 'despesa', nome: 'Em despesas', tipo: 'texto' },
      ],
      linhas: (db.prepare(`SELECT c.emissao, c.fornecedor_nome AS fornecedor, c.fornecedor_documento AS documento, c.numero, c.valor_produtos AS produtos,
          (c.valor_frete + c.valor_outras) AS outras, c.valor_desconto AS desconto, c.valor_total AS total,
          CASE WHEN EXISTS (SELECT 1 FROM compra_parcelas p WHERE p.compra_id = c.id AND p.despesa_id IS NOT NULL) THEN 'Sim' ELSE 'Não' END AS despesa
        FROM compras c WHERE c.empresa_id = ? AND c.emissao BETWEEN ? AND ? ORDER BY c.emissao, c.id`).all(e, f.de, f.ate) as any[]),
    }),
  },
  'fluxo-caixa': {
    grupo: 'Resultado e caixa',
    titulo: 'Fluxo de caixa por categoria', filtroData: 'Data do lançamento no extrato',
    descricao: 'Entradas e saídas classificadas a partir do extrato bancário importado.',
    gerar: (e, f) => {
      const b = balancoExtrato(e, f.de, f.ate);
      const linhas = [...b.entradas.map((x) => ({ categoria: x.categoria, tipo: 'Entrada', valor: x.total })), ...b.saidas.map((x) => ({ categoria: x.categoria, tipo: 'Saída', valor: -x.total }))];
      return { colunas: [{ k: 'tipo', nome: 'Tipo', tipo: 'texto' }, { k: 'categoria', nome: 'Categoria', tipo: 'texto' }, { k: 'valor', nome: 'Valor', tipo: 'moeda', soma: true }], linhas };
    },
  },
  // ---------------- Faturamento ----------------
  'faturamento-mensal': {
    grupo: 'Faturamento', titulo: 'Faturamento por mês', filtroData: 'Data de emissão da nota; recebimento pela data do pagamento',
    descricao: 'Mês a mês: quantas notas foram emitidas, quanto foi faturado, o que foi cancelado e quanto entrou em boletos pagos.',
    gerar: (e, f) => {
      const notas = db.prepare(`SELECT status, valor_servico AS v, substr(COALESCE(date(autorizada_em,'-3 hours'), date(criado_em,'-3 hours')),1,7) AS m
        FROM notas WHERE empresa_id = ? AND status IN ('AUTORIZADA','CANCELADA') ${f.tomadorId ? 'AND tomador_id = ' + Number(f.tomadorId) : ''}`).all(e) as any[];
      const pagos = db.prepare(`SELECT substr(pago_em,1,7) AS m, COALESCE(valor_pago, valor) AS v FROM cobrancas WHERE empresa_id = ? AND status = 'PAGO' AND pago_em BETWEEN ? AND ? ${f.tomadorId ? 'AND tomador_id = ' + Number(f.tomadorId) : ''}`).all(e, f.de, f.ate) as any[];
      const mm = new Map<string, any>(); const get = (m: string) => mm.get(m) ?? mm.set(m, { mes: m, qtd: 0, faturado: 0, cancelado: 0, recebido: 0 }).get(m);
      for (const n of notas) if (n.m >= f.de.slice(0, 7) && n.m <= f.ate.slice(0, 7)) { const r = get(n.m); if (n.status === 'CANCELADA') r.cancelado += n.v; else { r.qtd++; r.faturado += n.v; } }
      for (const c of pagos) get(c.m).recebido += c.v;
      const mo = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [{ k: 'mes', nome: 'Mês', tipo: 'texto' }, { k: 'qtd', nome: 'Notas', tipo: 'inteiro', soma: true }, mo('faturado', 'Faturado'), mo('cancelado', 'Canceladas'), mo('recebido', 'Recebido em boletos')],
        linhas: [...mm.values()].sort((a, b) => a.mes.localeCompare(b.mes)).map((r) => ({ ...r, mes: r.mes.split('-').reverse().join('/') })) };
    },
  },
  // ---------------- Contas a receber ----------------
  'prazo-recebimento': {
    grupo: 'Contas a receber', titulo: 'Prazo de recebimento por cliente', filtroData: 'Data do pagamento',
    descricao: 'Para cada cliente: quantos boletos foram pagos, em quantos dias após a emissão, quanto atrasam em média e quantos foram pagos em dia.',
    gerar: (e, f) => {
      const por = new Map<string, any>();
      for (const x of titulos(e, f.tomadorId).filter((x) => x.st === 'PAGO' && entre(x.pago_em, f))) {
        const r = por.get(x.cliente) ?? { cliente: x.cliente, qtd: 0, valor: 0, prazo: 0, atraso: 0, emDia: 0 };
        r.qtd++; r.valor += x.valor_pago ?? x.valor; r.prazo += Math.max(0, dias(x.pago_em ?? x.vencimento, x.emissao)); r.atraso += x.atraso; if (x.atraso === 0) r.emDia++; por.set(x.cliente, r);
      }
      const linhas = [...por.values()].map((r) => ({ ...r, prazo: Math.round(r.prazo / r.qtd), atraso: Math.round(r.atraso / r.qtd), pctEmDia: Math.round((r.emDia / r.qtd) * 100) })).sort((a, b) => b.atraso - a.atraso);
      return { colunas: [COL.cliente, { k: 'qtd', nome: 'Boletos pagos', tipo: 'inteiro', soma: true }, { k: 'valor', nome: 'Valor recebido', tipo: 'moeda', soma: true },
        { k: 'prazo', nome: 'Prazo médio (dias)', tipo: 'inteiro' }, { k: 'atraso', nome: 'Atraso médio (dias)', tipo: 'inteiro' }, { k: 'pctEmDia', nome: '% pago em dia', tipo: 'inteiro' }], linhas };
    },
  },
  // ---------------- Despesas e pagamentos ----------------
  'despesas-detalhe': {
    grupo: 'Despesas e pagamentos', titulo: 'Despesas lançadas', filtroData: 'Data da despesa',
    descricao: 'Todas as despesas do período, com categoria, forma de pagamento (PIX, débito, crédito, dinheiro) e de onde vieram (lançamento manual, extrato ou fatura do cartão).',
    gerar: (e, f) => ({
      colunas: [{ k: 'data', nome: 'Data', tipo: 'data' }, { k: 'categoria', nome: 'Categoria', tipo: 'texto' }, { k: 'descricao', nome: 'Descrição', tipo: 'texto' }, { k: 'forma', nome: 'Pago com', tipo: 'texto' }, { k: 'origem', nome: 'Origem', tipo: 'texto' }, { k: 'valor', nome: 'Valor', tipo: 'moeda', soma: true }],
      linhas: (db.prepare(`SELECT data, categoria, descricao, valor, forma_pagamento, origem FROM despesas WHERE empresa_id = ? AND data BETWEEN ? AND ? ORDER BY data, id`).all(e, f.de, f.ate) as any[])
        .map((d) => ({ ...d, forma: FORMA[d.forma_pagamento] ?? 'Não informado', origem: ORIGEM[d.origem] ?? d.origem })),
    }),
  },
  'despesas-categoria': {
    grupo: 'Despesas e pagamentos', titulo: 'Despesas por categoria', filtroData: 'Data da despesa',
    descricao: 'Quanto foi gasto em cada categoria no período e o peso de cada uma no total.',
    gerar: (e, f) => {
      const l = db.prepare('SELECT categoria, COUNT(*) AS qtd, SUM(valor) AS valor FROM despesas WHERE empresa_id = ? AND data BETWEEN ? AND ? GROUP BY categoria ORDER BY valor DESC').all(e, f.de, f.ate) as any[];
      const t = soma(l, 'valor') || 1;
      return { colunas: [{ k: 'categoria', nome: 'Categoria', tipo: 'texto' }, { k: 'qtd', nome: 'Lançamentos', tipo: 'inteiro', soma: true }, { k: 'valor', nome: 'Valor', tipo: 'moeda', soma: true }, { k: 'pct', nome: '% do total', tipo: 'inteiro' }],
        linhas: l.map((x) => ({ ...x, valor: r2(x.valor), pct: Math.round((x.valor / t) * 100) })) };
    },
  },
  'despesas-forma': {
    grupo: 'Despesas e pagamentos', titulo: 'Despesas por forma de pagamento', filtroData: 'Data da despesa',
    descricao: 'Quanto saiu por PIX, débito, crédito (cartão) e dinheiro. Despesas sem a forma informada aparecem separadas.',
    gerar: (e, f) => {
      const l = db.prepare('SELECT forma_pagamento AS f, COUNT(*) AS qtd, SUM(valor) AS valor FROM despesas WHERE empresa_id = ? AND data BETWEEN ? AND ? GROUP BY forma_pagamento ORDER BY valor DESC').all(e, f.de, f.ate) as any[];
      const t = soma(l, 'valor') || 1;
      return { colunas: [{ k: 'forma', nome: 'Pago com', tipo: 'texto' }, { k: 'qtd', nome: 'Lançamentos', tipo: 'inteiro', soma: true }, { k: 'valor', nome: 'Valor', tipo: 'moeda', soma: true }, { k: 'pct', nome: '% do total', tipo: 'inteiro' }],
        linhas: l.map((x) => ({ forma: FORMA[x.f] ?? 'Não informado', qtd: x.qtd, valor: r2(x.valor), pct: Math.round((x.valor / t) * 100) })) };
    },
  },
  'cartao-parcelas': {
    grupo: 'Despesas e pagamentos', titulo: 'Parcelas do cartão a vencer', filtroData: 'Posição atual (última fatura importada de cada compra)',
    descricao: 'Compras parceladas no cartão que ainda têm parcelas por vir: valor da parcela, quantas faltam, quanto ainda será cobrado e a previsão da última.',
    gerar: (e) => {
      const l = db.prepare(`SELECT c.descricao, c.cidade, MIN(c.data) AS compra, c.parcela_total AS total, c.valor, MAX(c.parcela_atual) AS atual, MAX(f.vencimento) AS ult
        FROM cartao_lancamentos c JOIN cartao_faturas f ON f.id = c.fatura_id WHERE c.empresa_id = ? AND c.parcela_total > 1 AND c.valor > 0
        GROUP BY c.descricao, c.data, c.parcela_total, c.valor HAVING MAX(c.parcela_atual) < c.parcela_total ORDER BY ult DESC, c.descricao`).all(e) as any[];
      const addMes = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
      return { colunas: [{ k: 'compra', nome: 'Compra', tipo: 'data' }, { k: 'descricao', nome: 'Estabelecimento', tipo: 'texto' }, { k: 'parcela', nome: 'Parcela atual', tipo: 'texto' }, { k: 'valor', nome: 'Valor da parcela', tipo: 'moeda' },
        { k: 'faltam', nome: 'Faltam', tipo: 'inteiro', soma: true }, { k: 'restante', nome: 'Total a vencer', tipo: 'moeda', soma: true }, { k: 'fim', nome: 'Última parcela', tipo: 'data' }],
        linhas: l.map((x) => ({ ...x, parcela: `${x.atual}/${x.total}`, faltam: x.total - x.atual, restante: r2((x.total - x.atual) * x.valor), fim: addMes(x.ult, x.total - x.atual) })) };
    },
  },
  // ---------------- Fiscal e retenções ----------------
  'livro-iss': {
    grupo: 'Fiscal e retenções', titulo: 'Livro de serviços prestados (ISS)', filtroData: 'Data de emissão da nota',
    descricao: 'Notas do período com base de cálculo, alíquota e ISS, separando o que o prestador recolhe do que o tomador reteve. Notas canceladas ficam de fora dos totais.',
    gerar: (e, f) => {
      const notas = db.prepare(`SELECT n_nfse, status, xml_nfse, tomador_nome AS cliente, valor_servico, COALESCE(date(autorizada_em,'-3 hours'), date(criado_em,'-3 hours')) AS emissao
        FROM notas WHERE empresa_id = ? AND status = 'AUTORIZADA' AND xml_nfse IS NOT NULL ${f.tomadorId ? 'AND tomador_id = ' + Number(f.tomadorId) : ''} ORDER BY emissao, id LIMIT 5000`).all(e) as any[];
      const linhas = notas.filter((n) => entre(n.emissao, f)).map((n) => {
        let v: any = {}; try { v = lerNfse(n.xml_nfse).valores; } catch { /* XML fora do padrão */ }
        const retido = ['2', '3'].includes(String(v.tpRetISSQN ?? '1')), iss = v.vISSQN ?? 0;
        return { ...n, base: v.vBC ?? n.valor_servico, aliq: v.pAliq ?? null, iss, recolher: retido ? 0 : iss, retido: retido ? iss : 0 };
      });
      const mo = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [COL.emissao, COL.nota, COL.cliente, COL.valorNota, mo('base', 'Base de cálculo'), { k: 'aliq', nome: 'Alíquota %', tipo: 'texto' }, mo('iss', 'ISS'), mo('recolher', 'ISS a recolher'), mo('retido', 'ISS retido pelo tomador')], linhas };
    },
  },
  'retencoes-cliente': {
    grupo: 'Fiscal e retenções', titulo: 'Retenções por cliente', filtroData: 'Data de emissão da nota',
    descricao: 'Quanto cada cliente reteve de PIS, COFINS, CSLL, IRRF, INSS e ISS nas notas do período, para conferir com os informes e pagamentos.',
    gerar: (e, f) => {
      const notas = db.prepare(`SELECT xml_nfse, tomador_nome AS cliente, valor_servico, COALESCE(date(autorizada_em,'-3 hours'), date(criado_em,'-3 hours')) AS emissao
        FROM notas WHERE empresa_id = ? AND status = 'AUTORIZADA' AND xml_nfse IS NOT NULL ${f.tomadorId ? 'AND tomador_id = ' + Number(f.tomadorId) : ''} LIMIT 5000`).all(e) as any[];
      const por = new Map<string, any>();
      for (const n of notas.filter((n) => entre(n.emissao, f))) {
        let v: any = {}; try { v = lerNfse(n.xml_nfse).valores; } catch { continue; }
        const r = por.get(n.cliente ?? '(sem cliente)') ?? { cliente: n.cliente ?? '(sem cliente)', notas: 0, valor: 0, pis: 0, cofins: 0, csll: 0, irrf: 0, cp: 0, iss: 0 };
        r.notas++; r.valor += n.valor_servico; r.pis += v.vPis ?? 0; r.cofins += v.vCofins ?? 0; r.csll += v.vRetCSLL ?? 0; r.irrf += v.vRetIRRF ?? 0; r.cp += v.vRetCP ?? 0;
        if (['2', '3'].includes(String(v.tpRetISSQN ?? '1'))) r.iss += v.vISSQN ?? 0; por.set(r.cliente, r);
      }
      const mo = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [COL.cliente, { k: 'notas', nome: 'Notas', tipo: 'inteiro', soma: true }, mo('valor', 'Valor das notas'), mo('pis', 'PIS'), mo('cofins', 'COFINS'), mo('csll', 'CSLL'), mo('irrf', 'IRRF'), mo('cp', 'INSS'), mo('iss', 'ISS retido')],
        linhas: ([...por.values()].map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === 'number' && k !== 'notas' ? r2(x) : x]))) as any[]).sort((a, b) => b.valor - a.valor) };
    },
  },
  // ---------------- Resultado e caixa ----------------
  'resultado-mensal': {
    grupo: 'Resultado e caixa', titulo: 'Resultado mensal (balanço)', filtroData: 'Meses do período (receita = boletos pagos + outras receitas; despesa = despesas lançadas)',
    descricao: 'O mesmo balanço de Despesas e balanço, mês a mês: receitas, despesas, resultado e margem.',
    gerar: (e, f) => {
      const linhas: any[] = []; let [a, m] = f.de.slice(0, 7).split('-').map(Number); const fim = f.ate.slice(0, 7);
      for (let i = 0; i < 60; i++) {
        const ym = `${a}-${String(m).padStart(2, '0')}`; if (ym > fim) break;
        const rec = r2(recebidoMes(e, ym)), des = r2(despesaMes(e, ym));
        linhas.push({ mes: `${String(m).padStart(2, '0')}/${a}`, receitas: rec, despesas: des, resultado: r2(rec - des), margem: rec ? Math.round(((rec - des) / rec) * 100) : null });
        if (++m > 12) { m = 1; a++; }
      }
      const mo = (k: string, nome: string): Coluna => ({ k, nome, tipo: 'moeda', soma: true });
      return { colunas: [{ k: 'mes', nome: 'Mês', tipo: 'texto' }, mo('receitas', 'Receitas'), mo('despesas', 'Despesas'), mo('resultado', 'Resultado'), { k: 'margem', nome: 'Margem %', tipo: 'inteiro' }], linhas };
    },
  },
  'pendencias-extrato': {
    grupo: 'Resultado e caixa', titulo: 'Pendências do extrato', filtroData: 'Data do lançamento no extrato',
    descricao: 'Lançamentos do extrato que ainda pedem ação: sem classificação, ou créditos de serviços sem boleto ligado.',
    gerar: (e, f) => ({
      colunas: [{ k: 'data', nome: 'Data', tipo: 'data' }, { k: 'descricao', nome: 'Descrição', tipo: 'texto' }, { k: 'valor', nome: 'Valor', tipo: 'moeda', soma: true }, { k: 'categoria', nome: 'Categoria', tipo: 'texto' }, { k: 'pendencia', nome: 'Pendência', tipo: 'texto' }],
      linhas: (db.prepare(`SELECT data, descricao, valor, categoria, cobranca_id FROM extrato_lancamentos WHERE empresa_id = ? AND data BETWEEN ? AND ?
          AND (categoria IS NULL OR (valor > 0 AND cobranca_id IS NULL AND categoria = 'Receita de serviços')) ORDER BY data, id`).all(e, f.de, f.ate) as any[])
        .map((x) => ({ ...x, pendencia: x.categoria ? 'Crédito sem boleto ligado' : 'Sem classificação' })),
    }),
  },
  // ---------------- Clientes ----------------
  'curva-abc': {
    grupo: 'Clientes', titulo: 'Curva ABC de clientes', filtroData: 'Data de emissão da nota',
    descricao: 'Clientes ordenados pelo valor faturado, com a participação de cada um e a classe: A (até 80% do faturamento), B (até 95%) e C (o restante).',
    gerar: (e, f) => {
      const l = (db.prepare(`SELECT COALESCE(tomador_nome, '(sem cliente)') AS cliente, COUNT(*) AS notas, SUM(valor_servico) AS valor FROM notas
        WHERE empresa_id = ? AND status = 'AUTORIZADA' AND COALESCE(date(autorizada_em,'-3 hours'), date(criado_em,'-3 hours')) BETWEEN ? AND ? GROUP BY tomador_id, tomador_nome ORDER BY valor DESC`).all(e, f.de, f.ate) as any[]);
      const t = soma(l, 'valor') || 1; let ac = 0;
      return { colunas: [COL.cliente, { k: 'notas', nome: 'Notas', tipo: 'inteiro', soma: true }, { k: 'valor', nome: 'Faturado', tipo: 'moeda', soma: true }, { k: 'pct', nome: '% do total', tipo: 'inteiro' }, { k: 'acum', nome: '% acumulado', tipo: 'inteiro' }, { k: 'classe', nome: 'Classe', tipo: 'texto' }],
        linhas: l.map((x) => { const antes = ac; ac += x.valor; return { ...x, valor: r2(x.valor), pct: Math.round((x.valor / t) * 100), acum: Math.round((ac / t) * 100), classe: antes / t < 0.8 ? 'A' : antes / t < 0.95 ? 'B' : 'C' }; }) };
    },
  },
  'cadastro-incompleto': {
    grupo: 'Clientes', titulo: 'Clientes com cadastro incompleto', filtroData: 'Sem filtro de data (situação atual do cadastro)',
    descricao: 'Clientes sem algum dado que faz falta na nota, no boleto ou no envio por e-mail: e-mail, telefone, endereço completo, município (código IBGE) ou CPF/CNPJ.',
    gerar: (e, f) => {
      const l = db.prepare(`SELECT t.* FROM tomadores t WHERE t.empresa_id = ? ${f.tomadorId ? 'AND t.id = ' + Number(f.tomadorId) : ''} ORDER BY t.nome`).all(e) as any[];
      const vazio = (v: any) => v == null || String(v).trim() === '';
      const linhas = l.map((t) => {
        const falta: string[] = [];
        if (vazio(t.email) && vazio(t.email_cobranca)) falta.push('e-mail');
        if (vazio(t.fone)) falta.push('telefone');
        if (['cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'].some((k) => vazio(t[k]))) falta.push('endereço');
        if (vazio(t.cod_municipio)) falta.push('município (IBGE)');
        if (t.tipo_doc !== 'EXTERIOR' && vazio(t.documento)) falta.push('CPF/CNPJ');
        const impacto = [falta.includes('endereço') || falta.includes('CPF/CNPJ') ? (t.modo_faturamento?.includes('BOLETO') ? 'boleto' : null) : null,
          falta.includes('município (IBGE)') || falta.includes('CPF/CNPJ') ? (t.modo_faturamento?.includes('NOTA') ? 'nota' : null) : null,
          falta.includes('e-mail') ? 'envio por e-mail' : null].filter(Boolean).join(', ');
        return { cliente: t.nome, documento: docFmt(t.documento ?? ''), falta: falta.join(', '), impacto: impacto || '—', qtd: falta.length };
      }).filter((x) => x.qtd).sort((a, b) => b.qtd - a.qtd || a.cliente.localeCompare(b.cliente));
      return { colunas: [COL.cliente, { k: 'documento', nome: 'CPF/CNPJ', tipo: 'texto' }, { k: 'falta', nome: 'O que falta', tipo: 'texto' }, { k: 'impacto', nome: 'Atrapalha', tipo: 'texto' }], linhas };
    },
  },
  'clientes-sem-nota': {
    grupo: 'Clientes', titulo: 'Clientes sem faturamento no período', filtroData: 'Data de emissão da nota',
    descricao: 'Clientes cadastrados que não tiveram nota autorizada no período, com a data e o valor da última nota. Serve para achar quem ficou sem faturar ou deixou de comprar.',
    gerar: (e, f) => ({
      colunas: [COL.cliente, { k: 'modo', nome: 'Faturamento', tipo: 'texto' }, { k: 'ultima', nome: 'Última nota', tipo: 'data' }, { k: 'valor', nome: 'Valor da última', tipo: 'moeda' }],
      linhas: (db.prepare(`SELECT t.nome AS cliente, t.modo_faturamento AS modo,
          (SELECT MAX(COALESCE(date(n.autorizada_em,'-3 hours'), date(n.criado_em,'-3 hours'))) FROM notas n WHERE n.tomador_id = t.id AND n.status = 'AUTORIZADA') AS ultima,
          (SELECT n.valor_servico FROM notas n WHERE n.tomador_id = t.id AND n.status = 'AUTORIZADA' ORDER BY COALESCE(n.autorizada_em, n.criado_em) DESC LIMIT 1) AS valor
        FROM tomadores t WHERE t.empresa_id = ? ${f.tomadorId ? 'AND t.id = ' + Number(f.tomadorId) : ''} AND NOT EXISTS (SELECT 1 FROM notas n WHERE n.tomador_id = t.id AND n.status = 'AUTORIZADA'
          AND COALESCE(date(n.autorizada_em,'-3 hours'), date(n.criado_em,'-3 hours')) BETWEEN ? AND ?) ORDER BY ultima IS NULL, ultima DESC, t.nome`).all(e, f.de, f.ate) as any[])
        .map((x) => ({ ...x, modo: ({ NOTA: 'Nota', NOTA_BOLETO: 'Nota + boleto', BOLETO: 'Boleto', NENHUM: 'Nenhum' } as any)[x.modo] ?? x.modo })),
    }),
  },
};

export const catalogo = () => Object.entries(RELATORIOS).map(([id, d]) => ({ id, grupo: d.grupo, titulo: d.titulo, descricao: d.descricao, filtroData: d.filtroData, situacoes: d.situacoes ?? null }));

export function gerarRelatorio(empresaId: number, id: string, f: Filtros): Relatorio {
  const def = RELATORIOS[id];
  if (!def) throw new ErroNegocio('Relatório não encontrado.', 404);
  if (f.de > f.ate) throw new ErroNegocio('A data inicial é maior que a final.');
  const { colunas, linhas } = def.gerar(empresaId, f);
  const totais: Record<string, number> = {};
  for (const c of colunas) if (c.soma) totais[c.k] = soma(linhas, c.k);
  const br = (d: string) => d.split('-').reverse().join('/');
  return { id, titulo: def.titulo, descricao: def.descricao, filtroData: def.filtroData, colunas, linhas, totais, subtitulo: def.filtroData.startsWith('Sem filtro') ? def.filtroData : `${def.filtroData}: ${br(f.de)} a ${br(f.ate)}${f.situacao ? ` · ${f.situacao}` : ''}` };
}

const fmt = (v: any, t: TipoColuna) => v == null || v === '' ? '' : t === 'moeda' ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t === 'data' ? String(v).slice(0, 10).split('-').reverse().join('/') : String(v);

export function relatorioCsv(r: Relatorio): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const l = [r.colunas.map((c) => q(c.nome)).join(';'), ...r.linhas.map((x) => r.colunas.map((c) => q(fmt(x[c.k], c.tipo))).join(';'))];
  if (r.colunas.some((c) => c.soma)) l.push(r.colunas.map((c, i) => q(i === 0 ? 'TOTAL' : c.soma ? fmt(r.totais[c.k], c.tipo) : '')).join(';'));
  return '﻿' + l.join('\r\n');
}

export function relatorioPdf(r: Relatorio, em: Emitente): Promise<Buffer> {
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, bufferPages: true, info: { Title: r.titulo } });
    const partes: Buffer[] = []; doc.on('data', (b) => partes.push(b)); doc.on('end', () => ok(Buffer.concat(partes)));
    const X = 16 * MM, W = doc.page.width - 2 * X, LIM = doc.page.height - 18 * MM;
    const peso = (c: Coluna) => (c.tipo === 'texto' ? (c.k === 'cliente' || c.k === 'servico' ? 3 : 1.3) : c.tipo === 'inteiro' ? 1.05 : 1.2);
    const tot = r.colunas.reduce((s, c) => s + peso(c), 0), larg = r.colunas.map((c) => (peso(c) / tot) * W);
    const alinhar = (i: number) => (r.colunas[i].tipo === 'moeda' || r.colunas[i].tipo === 'inteiro' ? 'right' : 'left');
    const celulas = (vals: string[], y: number, o: { negrito?: boolean; cor?: string; tam?: number } = {}) => {
      doc.font(o.negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.tam ?? 7.8).fillColor(o.cor ?? COR.texto);
      let x = X; vals.forEach((v, i) => { doc.text(v, x + 4, y, { width: larg[i] - 8, height: 11, ellipsis: true, lineBreak: false, align: alinhar(i) }); x += larg[i]; });
    };
    const cabTabela = (y: number) => {
      doc.rect(X, y, W, 7 * MM).fill(COR.claro);
      doc.moveTo(X, y + 7 * MM).lineTo(X + W, y + 7 * MM).lineWidth(1.1).stroke(COR.destaque);
      celulas(r.colunas.map((c) => c.nome), y + 2.3 * MM, { negrito: true });
      return y + 7 * MM + 2;
    };
    const pagina = () => {
      const y = cabecalho(doc, em, { titulo: r.titulo, subtitulo: `${r.subtitulo} · emitido em ${fmt(hojeBr(), 'data')}`, compacto: true });
      return cabTabela(y);
    };
    let y = pagina(), i = 0;
    for (const x of r.linhas) {
      if (y + 13 > LIM) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); y = pagina(); }
      if (x._subtotal) { doc.rect(X, y - 1, W, 13).fill('#ededeb'); i = 0; } else if (i++ % 2) doc.rect(X, y - 1, W, 13).fill('#f6f6f5');
      celulas(r.colunas.map((c) => fmt(x[c.k], c.tipo)), y + 2, { negrito: !!x._subtotal, cor: x._subtotal ? COR.escuro : undefined }); y += 13;
      doc.moveTo(X, y - 1).lineTo(X + W, y - 1).lineWidth(0.4).stroke(COR.linha);
    }
    if (r.colunas.some((c) => c.soma)) {
      if (y + 20 > LIM) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); y = pagina(); }
      y += 4; doc.rect(X, y, W, 8 * MM).fill(COR.escuro);
      celulas(r.colunas.map((c, k) => (k === 0 ? `TOTAL (${r.linhas.filter((l) => !l._subtotal).length})` : c.soma ? fmt(r.totais[c.k], c.tipo) : '')), y + 2.6 * MM, { negrito: true, cor: '#ffffff', tam: 8.2 });
    }
    if (!r.linhas.length) doc.fillColor(COR.cinza).font('Helvetica-Oblique').fontSize(10).text('Nenhum registro no período.', X, y + 10, { width: W, align: 'center' });
    rodapes(doc, em);
    doc.end();
  });
}
