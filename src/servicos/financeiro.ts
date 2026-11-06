import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaMes = (ym: string, n: number) => {
  let [y, m] = ym.split('-').map(Number);
  m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const CATEGORIAS_INICIAIS = ['Aluguel', 'Salários e encargos', 'Impostos e taxas', 'Água, luz e internet', 'Material e equipamentos', 'Software e sistemas', 'Marketing', 'Outras'];

// ---------- Despesas ----------
export const Despesa = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida'),
  categoria: z.string().trim().min(1, 'Informe a categoria').max(60),
  descricao: z.string().trim().max(200).nullish(),
  valor: z.number().positive('O valor precisa ser maior que zero'),
  forma_pagamento: z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO']).nullish(),
});
export const FORMAS_PAGAMENTO = { PIX: 'PIX', DEBITO: 'Débito', CREDITO: 'Crédito', DINHEIRO: 'Dinheiro' } as const;

export function listarCategorias(empresaId: number): string[] {
  const l = db.prepare('SELECT nome FROM despesa_categorias WHERE empresa_id = ? ORDER BY nome').all(empresaId) as { nome: string }[];
  if (!l.length) return CATEGORIAS_INICIAIS;
  return l.map((x) => x.nome);
}
export function salvarCategorias(empresaId: number, nomes: string[]) {
  const limpos = [...new Set(nomes.map((n) => n.trim()).filter(Boolean))].slice(0, 60);
  if (!limpos.length) throw new ErroNegocio('Mantenha ao menos uma categoria.');
  db.transaction(() => {
    db.prepare('DELETE FROM despesa_categorias WHERE empresa_id = ?').run(empresaId);
    const ins = db.prepare('INSERT INTO despesa_categorias (empresa_id, nome) VALUES (?,?)');
    limpos.forEach((n) => ins.run(empresaId, n));
  })();
}
export const listarDespesas = (empresaId: number, mes: string) =>
  db.prepare('SELECT id, data, categoria, descricao, valor, forma_pagamento, origem, extrato_lancamento_id, cartao_lancamento_id FROM despesas WHERE empresa_id = ? AND substr(data,1,7) = ? ORDER BY data DESC, id DESC').all(empresaId, mes);
export function criarDespesa(empresaId: number, usuarioId: number, d: z.infer<typeof Despesa>) {
  return Number(db.prepare('INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, criado_por, forma_pagamento) VALUES (?,?,?,?,?,?,?)').run(empresaId, d.data, d.categoria, d.descricao ?? null, d.valor, usuarioId, d.forma_pagamento ?? null).lastInsertRowid);
}
export function editarDespesa(empresaId: number, id: number, d: z.infer<typeof Despesa>) {
  conferirNaoEspelho(empresaId, id);
  const r = db.prepare('UPDATE despesas SET data = ?, categoria = ?, descricao = ?, valor = ?, forma_pagamento = ? WHERE id = ? AND empresa_id = ?').run(d.data, d.categoria, d.descricao ?? null, d.valor, d.forma_pagamento ?? null, id, empresaId);
  if (!r.changes) throw new ErroNegocio('Despesa não encontrada.', 404);
}
/** Despesa espelhada do extrato bancário muda no Extrato e conciliação, não aqui. */
function conferirNaoEspelho(empresaId: number, id: number) {
  const x = db.prepare('SELECT origem FROM despesas WHERE id = ? AND empresa_id = ?').get(id, empresaId) as { origem: string } | undefined;
  if (x && x.origem !== 'MANUAL') throw new ErroNegocio('Este lançamento veio do extrato ou da fatura do cartão: altere a categoria na tela de origem.');
}
export function excluirDespesa(empresaId: number, id: number) {
  conferirNaoEspelho(empresaId, id);
  if (!db.prepare('DELETE FROM despesas WHERE id = ? AND empresa_id = ?').run(id, empresaId).changes) throw new ErroNegocio('Despesa não encontrada.', 404);
}

// ---------- Painel e balanço ----------
export const recebidoMes = (empresaId: number, ym: string) =>
  (db.prepare("SELECT COALESCE(SUM(COALESCE(valor_pago, valor)),0) AS v FROM cobrancas WHERE empresa_id = ? AND status = 'PAGO' AND substr(COALESCE(pago_em, vencimento),1,7) = ?").get(empresaId, ym) as { v: number }).v
  // entradas do extrato que o usuário classificou como "Outras receitas" (sem boleto) também são receita
  + (db.prepare("SELECT COALESCE(SUM(valor),0) AS v FROM extrato_lancamentos WHERE empresa_id = ? AND valor > 0 AND cobranca_id IS NULL AND categoria = 'Outras receitas' AND substr(data,1,7) = ?").get(empresaId, ym) as { v: number }).v;
export const despesaMes = (empresaId: number, ym: string) =>
  (db.prepare('SELECT COALESCE(SUM(valor),0) AS v FROM despesas WHERE empresa_id = ? AND substr(data,1,7) = ?').get(empresaId, ym) as { v: number }).v;

export function painelFinanceiro(empresaId: number, mes: string, hoje = hojeBr()) {
  const cobs = db.prepare(`SELECT c.id, c.valor, c.valor_pago, c.vencimento, c.status, c.pago_em, c.tomador_id, t.nome AS tomador FROM cobrancas c
    JOIN tomadores t ON t.id = c.tomador_id WHERE c.empresa_id = ? AND c.status <> 'CANCELADO'`).all(empresaId) as any[];
  const aberta = (c: any) => c.status !== 'PAGO';
  const atrasada = (c: any) => aberta(c) && c.vencimento < hoje;
  const doMes = cobs.filter((c) => c.vencimento.slice(0, 7) === mes);
  const soma = (l: any[], f: (c: any) => number = (c) => c.valor) => r2(l.reduce((t, c) => t + f(c), 0));
  const pagas = doMes.filter((c) => c.status === 'PAGO'), emAtraso = doMes.filter(atrasada), aReceber = doMes.filter((c) => aberta(c) && !atrasada(c));

  const meses = Array.from({ length: 6 }, (_, i) => somaMes(mes, i - 5));
  const serie = meses.map((m) => {
    const l = cobs.filter((c) => c.vencimento.slice(0, 7) === m);
    return { mes: m, recebido: soma(l.filter((c) => c.status === 'PAGO'), (c) => c.valor_pago ?? c.valor), aberto: soma(l.filter(aberta)) };
  });
  const balanco = meses.map((m) => { const rec = r2(recebidoMes(empresaId, m)), des = r2(despesaMes(empresaId, m)); return { mes: m, receitas: rec, despesas: des, resultado: r2(rec - des) }; });

  const atrasadas = cobs.filter(atrasada).sort((a, b) => a.vencimento.localeCompare(b.vencimento)).slice(0, 8)
    .map((c) => ({ id: c.id, tomador: c.tomador, valor: c.valor, vencimento: c.vencimento, dias: Math.round((Date.parse(hoje) - Date.parse(c.vencimento)) / 864e5) }));

  const faltam = db.prepare(`SELECT t.id, t.nome FROM tomadores t WHERE t.empresa_id = ? AND t.modo_faturamento IN ('NOTA','NOTA_BOLETO','BOLETO')
    AND NOT EXISTS (SELECT 1 FROM cobrancas c WHERE c.tomador_id = t.id AND c.status <> 'CANCELADO' AND substr(c.criado_em,1,7) = ?)
    AND NOT EXISTS (SELECT 1 FROM notas n WHERE n.tomador_id = t.id AND n.status = 'AUTORIZADA' AND substr(n.competencia,1,7) = ?)
    ORDER BY t.nome`).all(empresaId, mes, mes) as { id: number; nome: string }[];
  const totalClientes = (db.prepare("SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id = ? AND modo_faturamento IN ('NOTA','NOTA_BOLETO','BOLETO')").get(empresaId) as { n: number }).n;

  const faturado = soma(doMes);
  return {
    mes, hoje,
    kpis: { faturado, recebido: soma(pagas, (c) => c.valor_pago ?? c.valor), aReceber: soma(aReceber), emAtraso: soma(emAtraso),
      qtd: doMes.length, qtdPagas: pagas.length, qtdAReceber: aReceber.length, qtdAtraso: emAtraso.length, pctRecebido: faturado ? Math.round((soma(pagas) / faturado) * 100) : 0,
      inadimplencia: doMes.length ? Math.round((emAtraso.length / doMes.length) * 100) : 0 },
    serie, balanco, atrasadas, faltamEmitir: { qtd: faltam.length, total: totalClientes, clientes: faltam.slice(0, 10) },
    dicas: dicas(empresaId, mes, hoje, cobs, balanco, faltam.length, totalClientes),
  };
}

const fk = (n: number) => (n >= 1000 ? `R$ ${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const nomeMes = (ym: string) => ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(ym.slice(5)) - 1] + '/' + ym.slice(2, 4);
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** Observações práticas para o painel, da mais importante para a menos (no máximo 5). */
function dicas(empresaId: number, mes: string, hoje: string, cobs: any[], balanco: { mes: string; receitas: number; despesas: number }[], faltam: number, totalClientes: number): string[] {
  const T: { p: number; t: string }[] = [];
  const add = (p: number, t: string) => T.push({ p, t });
  const atras = cobs.filter((c) => c.status !== 'PAGO' && c.vencimento < hoje);
  if (atras.length) {
    const v = atras.reduce((t, c) => t + c.valor, 0), velho = Math.max(...atras.map((c) => dias(c.vencimento, hoje)));
    add(1, `${atras.length} cobrança(s) em atraso somam ${fk(v)} (a mais antiga há ${velho} dia(s)). Quanto antes o lembrete, maior a chance de receber.`);
  }
  const breve = cobs.filter((c) => c.status !== 'PAGO' && c.vencimento >= hoje && dias(hoje, c.vencimento) <= 3);
  if (breve.length) add(3, `${breve.length} cobrança(s) vencem nos próximos 3 dias (${fk(breve.reduce((t, c) => t + c.valor, 0))}). Um lembrete amigável costuma evitar o atraso.`);
  if (totalClientes && faltam) add(2, `Faltam ${faltam} de ${totalClientes} cliente(s) para emitir em ${nomeMes(mes)}. Emitir cedo dá mais prazo para receber.`);

  const prev = somaMes(hoje.slice(0, 7), -1);
  const b = balanco.find((x) => x.mes === prev) ?? { receitas: recebidoMes(empresaId, prev), despesas: despesaMes(empresaId, prev) };
  const res = b.receitas - b.despesas;
  if (b.receitas > 0 || b.despesas > 0) {
    if (res < 0) add(1, `Em ${nomeMes(prev)} as despesas (${fk(b.despesas)}) superaram o que entrou (${fk(b.receitas)}) em ${fk(-res)}. Vale rever os maiores gastos e as cobranças em aberto.`);
    else if (b.receitas > 0) {
      const mg = Math.round((res / b.receitas) * 100);
      add(mg < 15 ? 3 : 6, mg < 15 ? `A margem de ${nomeMes(prev)} foi de ${mg}%: sobrou pouco de cada real recebido. Reveja despesas fixas ou o preço dos serviços.` : `Em ${nomeMes(prev)} sobraram ${fk(res)} (margem de ${mg}%). Guardar parte como reserva ajuda nos meses mais fracos.`);
    }
    const porCat = db.prepare('SELECT categoria, SUM(valor) AS v FROM despesas WHERE empresa_id = ? AND substr(data,1,7) = ? GROUP BY categoria ORDER BY v DESC LIMIT 1').get(empresaId, prev) as { categoria: string; v: number } | undefined;
    if (porCat && b.despesas > 0 && porCat.v / b.despesas >= 0.4) add(4, `"${porCat.categoria}" respondeu por ${Math.round((porCat.v / b.despesas) * 100)}% das despesas de ${nomeMes(prev)} (${fk(porCat.v)}). Compare preços e contratos nessa categoria.`);
    const antes = despesaMes(empresaId, somaMes(prev, -1));
    if (antes > 0 && b.despesas > antes * 1.2) add(3, `As despesas de ${nomeMes(prev)} subiram ${Math.round((b.despesas / antes - 1) * 100)}% sobre o mês anterior (${fk(antes)} → ${fk(b.despesas)}). Confira o que mudou.`);
  }
  const tres = [prev, somaMes(prev, -1), somaMes(prev, -2)];
  const recentes = cobs.filter((c) => tres.includes(c.vencimento.slice(0, 7)));
  const tot = recentes.reduce((t, c) => t + c.valor, 0);
  if (tot > 0) {
    const por = new Map<string, number>();
    recentes.forEach((c) => por.set(c.tomador, (por.get(c.tomador) ?? 0) + c.valor));
    const [nome, v] = [...por.entries()].sort((a, b2) => b2[1] - a[1])[0];
    if (por.size > 1 && v / tot >= 0.4) add(5, `${nome} representa ${Math.round((v / tot) * 100)}% do faturamento dos últimos 3 meses. Depender de um só cliente é risco: vale buscar novos.`);
  }
  const vencidas = cobs.filter((c) => c.vencimento < hoje);
  if (vencidas.length >= 5) {
    const pct = Math.round((vencidas.filter((c) => c.status !== 'PAGO').length / vencidas.length) * 100);
    if (pct >= 25) add(2, `${pct}% das cobranças já vencidas ainda não foram pagas. Considere lembretes antes do vencimento.`);
  }
  const temDespesa = (db.prepare('SELECT COUNT(*) AS n FROM despesas WHERE empresa_id = ?').get(empresaId) as { n: number }).n > 0;
  if (cobs.length && !temDespesa) add(7, 'Você ainda não lançou despesas. Sem elas o balanço mostra só receita, não o lucro de verdade: lance ao menos as despesas fixas do mês.');
  if (!T.length) add(9, 'Tudo em ordem por aqui. Marcar as cobranças pagas e lançar as despesas deixa o balanço confiável.');
  return T.sort((a, b2) => a.p - b2.p).slice(0, 5).map((x) => x.t);
}
