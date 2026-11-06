import { tributacaoCompletaDoServico } from './tributacao.js';
import { db } from '../db.js';
import type { Usuario } from '../auth.js';
import { motivoNaoUtil } from './diautil.js';
import { ErroNegocio } from './emissao.js';
import { EntradaFaturamento, faturar } from './faturamento.js';

/**
 * Emissão automática mensal: cada cliente com agenda ativa e serviços padrão tem, a cada mês, uma data prevista
 * (o dia escolhido, passando para o próximo dia útil). Chegada a data, os itens ficam "prontos para confirmar":
 * o sistema nunca emite sozinho; a pessoa confirma um a um ou todos de uma vez.
 */
export type StatusAgenda = 'SEM_AGENDA' | 'AGENDADA' | 'PRONTA' | 'EMITIDA' | 'ERRO' | 'PULADA';

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const proximoDia = (d: string) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);

/** Data prevista no mês: o dia escolhido (limitado ao último dia do mês), empurrado para o próximo dia útil. */
export function dataPrevista(mes: string, dia: number, extras?: string | null): string {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  let d = `${mes}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
  for (let i = 0; i < 10 && motivoNaoUtil(d, extras); i++) d = proximoDia(d);
  return d;
}

export interface ItemAgenda {
  tomador_id: number; tomador: string; servico_id: number; servico: string; valor: number; modo: string;
  agenda_ativa: boolean; agenda_dia: number | null; data_prevista: string | null; status: StatusAgenda;
  nota_id: number | null; cobranca_id: number | null; mensagem: string | null;
}

export function listarAgenda(empresaId: number, mes: string, hoje = hojeBr()): ItemAgenda[] {
  const extras = (db.prepare('SELECT feriados_extra FROM empresas WHERE id = ?').get(empresaId) as any)?.feriados_extra;
  const linhas = db.prepare(`SELECT t.id AS tomador_id, t.nome AS tomador, t.modo_faturamento AS modo, t.agenda_ativa, t.agenda_dia,
      ts.servico_id, ts.valor, s.nome AS servico, ex.status AS ex_status, ex.nota_id, ex.cobranca_id, ex.mensagem
    FROM tomadores t JOIN tomador_servicos ts ON ts.tomador_id = t.id JOIN servicos s ON s.id = ts.servico_id
    LEFT JOIN agenda_execucoes ex ON ex.tomador_id = t.id AND ex.servico_id = ts.servico_id AND ex.competencia = ?
    WHERE t.empresa_id = ? ORDER BY t.nome, ts.padrao DESC, s.nome`).all(mes, empresaId) as any[];
  return linhas.map((l): ItemAgenda => {
    const ativa = !!l.agenda_ativa && !!l.agenda_dia;
    const data = ativa ? dataPrevista(mes, l.agenda_dia, extras) : null;
    const status: StatusAgenda = l.ex_status ?? (!ativa ? 'SEM_AGENDA' : data! <= hoje ? 'PRONTA' : 'AGENDADA');
    return { tomador_id: l.tomador_id, tomador: l.tomador, servico_id: l.servico_id, servico: l.servico, valor: l.valor, modo: l.modo,
      agenda_ativa: ativa, agenda_dia: l.agenda_dia, data_prevista: data, status, nota_id: l.nota_id ?? null, cobranca_id: l.cobranca_id ?? null, mensagem: l.mensagem ?? null };
  });
}

export function configurarAgenda(empresaId: number, tomadorId: number, ativa: boolean, dia: number | null) {
  const t = db.prepare('SELECT id FROM tomadores WHERE id = ? AND empresa_id = ?').get(tomadorId, empresaId);
  if (!t) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (ativa) {
    if (!dia || dia < 1 || dia > 31) throw new ErroNegocio('Escolha o dia do mês (1 a 31).');
    if (!db.prepare('SELECT 1 FROM tomador_servicos WHERE tomador_id = ?').get(tomadorId)) throw new ErroNegocio('Cadastre ao menos um serviço padrão para este cliente (aba Serviços padrão).');
  }
  db.prepare('UPDATE tomadores SET agenda_ativa = ?, agenda_dia = ? WHERE id = ?').run(ativa ? 1 : 0, ativa ? dia : null, tomadorId);
}

const registrar = (empresaId: number, tomadorId: number, servicoId: number, mes: string, status: string, valor: number, notaId: number | null, cobId: number | null, msg: string | null) =>
  db.prepare(`INSERT INTO agenda_execucoes (empresa_id, tomador_id, servico_id, competencia, status, valor, nota_id, cobranca_id, mensagem) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tomador_id, servico_id, competencia) DO UPDATE SET status = excluded.status, valor = excluded.valor, nota_id = excluded.nota_id, cobranca_id = excluded.cobranca_id, mensagem = excluded.mensagem, criado_em = datetime('now')`)
    .run(empresaId, tomadorId, servicoId, mes, status, valor, notaId, cobId, msg);

/** Monta a entrada de faturamento a partir do serviço padrão do cliente e da tributação do serviço. */
function entradaDoItem(empresa: any, tomador: any, ts: any, serv: any, mes: string, hoje: string): EntradaFaturamento {
  const comp = tributacaoCompletaDoServico(serv);
  const t = comp.tributacao ?? {};
  const competencia = hoje.slice(0, 7) === mes ? hoje : `${mes}-${String(Math.min(new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5), 0)).getUTCDate(), tomador.agenda_dia ?? 1)).padStart(2, '0')}`;
  const pt = t.pTotTrib;
  return EntradaFaturamento.parse({
    empresaId: empresa.id, tomadorId: tomador.id, servicoId: serv.id, competencia,
    descricao: ts.descricao || serv.descricao, valor: ts.valor,
    aliquota: comp.aliquota ?? undefined, tribISSQN: t.tribISSQN ?? 1, issRetido: t.issRetido ?? 1, tpImunidade: t.tribISSQN === 2 ? t.tpImunidade ?? undefined : undefined,
    municipioPrestacao: t.municipioPrestacao || undefined, infoComplementar: t.infoComplementar || undefined,
    pTotTrib: empresa.op_simp_nac === 1 && pt ? { fed: pt.fed ?? 0, est: pt.est ?? 0, mun: pt.mun ?? 0 } : undefined,
    acao: empresa.modo_emissao === 'PORTAL' ? 'BOLETO' : tomador.modo_faturamento,
  });
}

export async function executarItem(u: Usuario, empresaId: number, tomadorId: number, servicoId: number, mes: string, hoje = hojeBr()) {
  const atual = db.prepare('SELECT status FROM agenda_execucoes WHERE tomador_id = ? AND servico_id = ? AND competencia = ?').get(tomadorId, servicoId, mes) as any;
  if (atual?.status === 'EMITIDA') throw new ErroNegocio('Este item já foi emitido neste mês.');
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ? AND empresa_id = ?').get(tomadorId, empresaId) as any;
  const ts = db.prepare('SELECT * FROM tomador_servicos WHERE tomador_id = ? AND servico_id = ?').get(tomadorId, servicoId) as any;
  const serv = db.prepare('SELECT * FROM servicos WHERE id = ? AND empresa_id = ?').get(servicoId, empresaId) as any;
  if (!empresa || !tomador || !ts || !serv) throw new ErroNegocio('Item da agenda não encontrado.', 404);
  if (empresa.modo_emissao === 'PORTAL' && tomador.modo_faturamento === 'NOTA') {
    const msg = 'Esta empresa emite a nota pelo portal e o cliente é só de nota: não há boleto para gerar aqui.';
    registrar(empresaId, tomadorId, servicoId, mes, 'ERRO', ts.valor, null, null, msg);
    return { status: 'ERRO' as const, mensagem: msg };
  }
  try {
    const r = await faturar(u, entradaDoItem(empresa, tomador, ts, serv, mes, hoje));
    const ok = r.acao === 'BOLETO' ? !!r.cobranca : r.nota?.status === 'AUTORIZADA';
    const msg = ok ? (r.avisos.join(' ') || null) : (r.nota?.erros?.map((e: any) => `${e.codigo} ${e.descricao}`).join('; ') || r.avisos.join(' ') || 'A nota não foi autorizada.');
    registrar(empresaId, tomadorId, servicoId, mes, ok ? 'EMITIDA' : 'ERRO', ts.valor, r.nota?.id ?? null, r.cobranca?.id ?? null, msg);
    return { status: ok ? 'EMITIDA' as const : 'ERRO' as const, mensagem: msg, nota: r.nota, cobranca: r.cobranca };
  } catch (e: any) {
    const msg = e instanceof ErroNegocio || e?.message ? String(e.message) : 'Falha ao emitir.';
    registrar(empresaId, tomadorId, servicoId, mes, 'ERRO', ts.valor, null, null, msg);
    return { status: 'ERRO' as const, mensagem: msg };
  }
}

export async function executarProntas(u: Usuario, empresaId: number, mes: string, hoje = hojeBr()) {
  const prontas = listarAgenda(empresaId, mes, hoje).filter((i) => i.status === 'PRONTA' || i.status === 'ERRO').slice(0, 100);
  let emitidas = 0, erros = 0;
  for (const i of prontas) {
    const r = await executarItem(u, empresaId, i.tomador_id, i.servico_id, mes, hoje);
    r.status === 'EMITIDA' ? emitidas++ : erros++;
  }
  return { total: prontas.length, emitidas, erros };
}

export function pularItem(empresaId: number, tomadorId: number, servicoId: number, mes: string, desfazer = false) {
  const ts = db.prepare('SELECT valor FROM tomador_servicos ts JOIN tomadores t ON t.id = ts.tomador_id WHERE ts.tomador_id = ? AND ts.servico_id = ? AND t.empresa_id = ?').get(tomadorId, servicoId, empresaId) as any;
  if (!ts) throw new ErroNegocio('Item da agenda não encontrado.', 404);
  if (desfazer) { db.prepare("DELETE FROM agenda_execucoes WHERE tomador_id = ? AND servico_id = ? AND competencia = ? AND status = 'PULADA'").run(tomadorId, servicoId, mes); return; }
  const ex = db.prepare('SELECT status FROM agenda_execucoes WHERE tomador_id = ? AND servico_id = ? AND competencia = ?').get(tomadorId, servicoId, mes) as any;
  if (ex?.status === 'EMITIDA') throw new ErroNegocio('Este item já foi emitido.');
  registrar(empresaId, tomadorId, servicoId, mes, 'PULADA', ts.valor, null, null, 'Pulado neste mês');
}

export const resumoAgenda = (empresaId: number, mes: string) => {
  const l = listarAgenda(empresaId, mes);
  return { prontas: l.filter((i) => i.status === 'PRONTA').length, erros: l.filter((i) => i.status === 'ERRO').length, agendadas: l.filter((i) => i.status === 'AGENDADA').length };
};
