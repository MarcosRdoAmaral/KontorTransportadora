import { strToU8, zipSync } from 'fflate';
import { db } from '../db.js';
import { ErroNegocio, danfse } from './emissao.js';
import { obterConta } from './cobranca.js';
import { enviarPacoteContabilidade, ListaEmails } from './email.js';
import { z } from 'zod';

export interface Movimento { data: string; valor: number; tipo: 'CREDIT' | 'DEBIT'; id: string; historico: string }

const ymd = (d: string) => d.replace(/-/g, '');
const xmlTxt = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const num = (v: number) => v.toFixed(2);
const sgml = (s: string) => s.replace(/[\r\n<>&]+/g, ' ').trim().slice(0, 64);

/** Movimentação do período: extrato importado ou, na falta dele, boletos pagos (entradas) e despesas lançadas (saídas). */
export function movimentos(empresaId: number, de: string, ate: string): Movimento[] {
  // com extrato bancário importado, ele é a fonte oficial (já traz tudo que passou pela conta)
  const extrato = db.prepare('SELECT id, data, valor, descricao, documento, categoria FROM extrato_lancamentos WHERE empresa_id = ? AND data BETWEEN ? AND ? ORDER BY data, id').all(empresaId, de, ate) as any[];
  if (extrato.length) {
    return extrato.map((r): Movimento => ({ data: r.data, valor: Math.abs(r.valor), tipo: r.valor > 0 ? 'CREDIT' : 'DEBIT', id: `KG-EXT-${r.id}`, historico: `${r.descricao}${r.documento ? ' ' + r.documento : ''}${r.categoria ? ' [' + r.categoria + ']' : ''}` }));
  }
  const entradas = db.prepare(`SELECT c.id, substr(c.pago_em,1,10) AS data, COALESCE(c.valor_pago, c.valor) AS valor, c.descricao, t.nome
      FROM cobrancas c LEFT JOIN tomadores t ON t.id = c.tomador_id
      WHERE c.empresa_id = ? AND c.status = 'PAGO' AND c.pago_em IS NOT NULL AND substr(c.pago_em,1,10) BETWEEN ? AND ?`).all(empresaId, de, ate) as any[];
  const saidas = db.prepare('SELECT id, data, valor, categoria, descricao FROM despesas WHERE empresa_id = ? AND data BETWEEN ? AND ?').all(empresaId, de, ate) as any[];
  return [
    ...entradas.map((r): Movimento => ({ data: r.data, valor: r.valor, tipo: 'CREDIT', id: `KG-REC-${r.id}`, historico: `RECEBIMENTO ${r.nome ?? ''} ${r.descricao ?? ''}` })),
    ...saidas.map((r): Movimento => ({ data: r.data, valor: r.valor, tipo: 'DEBIT', id: `KG-DES-${r.id}`, historico: `${r.categoria}${r.descricao ? ' - ' + r.descricao : ''}` })),
  ].sort((a, b) => a.data.localeCompare(b.data) || a.id.localeCompare(b.id));
}

/** Arquivo OFX 1.02 (SGML) com a movimentação do período, aceito pelos sistemas contábeis. */
export function gerarOfx(empresaId: number, de: string, ate: string): string {
  const conta = obterConta(empresaId);
  const mv = movimentos(empresaId, de, ate);
  const saldo = mv.reduce((s, m) => s + (m.tipo === 'CREDIT' ? m.valor : -m.valor), 0);
  const linhas = mv.map((m) => `<STMTTRN>
<TRNTYPE>${m.tipo}
<DTPOSTED>${ymd(m.data)}120000[-3:BRT]
<TRNAMT>${num(m.tipo === 'CREDIT' ? m.valor : -m.valor)}
<FITID>${m.id}
<MEMO>${sgml(m.historico)}
</STMTTRN>`).join('\n');
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>${ymd(new Date().toISOString().slice(0, 10))}120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>085<BRANCHID>${conta?.agencia ?? '0'}<ACCTID>${conta ? conta.conta + conta.conta_dv : '0'}<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${ymd(de)}120000[-3:BRT]<DTEND>${ymd(ate)}120000[-3:BRT]
${linhas}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>${num(saldo)}<DTASOF>${ymd(ate)}120000[-3:BRT]</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;
}

/** Notas de entrada (compras) do período: XML por chave e planilha. Inclui as da SEFAZ ainda não lançadas e marca as canceladas pelo fornecedor. */
function entradasDoPeriodo(empresaId: number, de: string, ate: string, arq: Record<string, Uint8Array>, comCompras: boolean, comSefaz: boolean) {
  const compras = db.prepare(`SELECT c.id, c.fornecedor_nome, c.fornecedor_documento, c.numero, c.serie, c.emissao, c.valor_total, c.chave_acesso, c.origem, c.xml,
      (SELECT group_concat(strftime('%d/%m/%Y', p.vencimento) || ' ' || printf('%.2f', p.valor), ' | ') FROM compra_parcelas p WHERE p.compra_id = c.id) AS parcelas,
      (SELECT r.situacao FROM nfe_recebidas r WHERE r.empresa_id = c.empresa_id AND r.chave = c.chave_acesso) AS sit_sefaz
    FROM compras c WHERE c.empresa_id = ? AND c.emissao BETWEEN ? AND ? ORDER BY c.emissao, c.id LIMIT 5000`).all(empresaId, de, ate) as any[];
  const soSefaz = db.prepare(`SELECT chave, numero, serie, emitente_nome, emitente_documento, emissao, valor, situacao, xml FROM nfe_recebidas
    WHERE empresa_id = ? AND oculta = 0 AND emissao BETWEEN ? AND ? AND chave NOT IN (SELECT chave_acesso FROM compras WHERE empresa_id = ? AND chave_acesso IS NOT NULL)
    ORDER BY emissao LIMIT 5000`).all(empresaId, de, ate, empresaId) as any[];
  const br = (d: string | null) => (d ? d.split('-').reverse().join('/') : '');
  const linhas: unknown[][] = [];
  for (const c of comCompras ? compras : []) {
    if (c.xml) arq[`entradas/xml/NFe_${c.chave_acesso ?? c.numero ?? c.id}.xml`] = strToU8(c.xml);
    const sit = c.sit_sefaz === 'CANCELADA' ? 'CANCELADA PELO FORNECEDOR (conferir)' : c.sit_sefaz === 'DENEGADA' ? 'DENEGADA' : 'Lançada em compras';
    linhas.push([c.origem === 'MANUAL' ? 'Lançamento manual (sem XML)' : 'XML importado', sit, br(c.emissao), c.fornecedor_nome, c.fornecedor_documento, c.numero, c.serie, num(c.valor_total).replace('.', ','), c.chave_acesso, c.parcelas]);
  }
  for (const r of comSefaz ? soSefaz : []) {
    if (r.xml) arq[`entradas/xml/NFe_${r.chave}.xml`] = strToU8(r.xml);
    const sit = r.situacao === 'CANCELADA' ? 'CANCELADA PELO FORNECEDOR' : r.situacao === 'DENEGADA' ? 'DENEGADA' : r.xml ? 'Recebida da SEFAZ, não lançada' : 'Só resumo da SEFAZ (XML ainda não liberado)';
    linhas.push(['SEFAZ', sit, br(r.emissao), r.emitente_nome, r.emitente_documento, r.numero, r.serie, r.valor != null ? num(r.valor).replace('.', ',') : '', r.chave, '']);
  }
  if (!linhas.length) return;
  const cab = ['Origem', 'Situação', 'Emissão', 'Fornecedor', 'CNPJ/CPF', 'Número', 'Série', 'Valor total', 'Chave de acesso', 'Parcelas'];
  arq['entradas/relatorio-entradas.csv'] = strToU8('﻿' + [cab.map(csv).join(';'), ...linhas.map((l) => l.map(csv).join(';'))].join('\r\n'));
}

export interface OpcoesPacote { de: string; ate: string; xml: boolean; pdf: boolean; ofx: boolean; entradas?: boolean; sefaz?: boolean }

/** ZIP para a contabilidade: XML e PDF das notas do período, OFX da movimentação e planilha-índice. */
export async function pacoteContabilidade(empresaId: number, o: OpcoesPacote): Promise<{ zip: Buffer; nome: string }> {
  const emp = db.prepare('SELECT razao_social, documento, ambiente FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!emp) throw new ErroNegocio('Empresa não encontrada.', 404);
  if (o.de > o.ate) throw new ErroNegocio('A data inicial é maior que a final.');
  if (!o.xml && !o.pdf && !o.ofx && !o.entradas && !o.sefaz) throw new ErroNegocio('Marque ao menos um tipo de arquivo.');
  const arq: Record<string, Uint8Array> = {};
  const notas = db.prepare(`SELECT id, n_nfse, status, competencia, valor_servico, tomador_nome, tomador_documento, chave_acesso, xml_nfse
      FROM notas WHERE empresa_id = ? AND ambiente = ? AND xml_nfse IS NOT NULL AND competencia BETWEEN ? AND ? ORDER BY competencia, id LIMIT 5000`)
    .all(empresaId, emp.ambiente, o.de, o.ate) as any[];
  if (o.xml || o.pdf) {
    for (const n of notas) {
      if (o.xml) arq[`notas/xml/NFSe_${n.n_nfse}.xml`] = strToU8(n.xml_nfse);
      if (o.pdf) arq[`notas/pdf/NFSe_${n.n_nfse}.pdf`] = await danfse(n.id);
    }
    const cab = ['Número', 'Situação', 'Competência', 'Tomador', 'CPF/CNPJ', 'Valor do serviço', 'Chave de acesso'];
    arq['notas/relatorio-notas.csv'] = strToU8('﻿' + [cab.map(csv).join(';'), ...notas.map((n) => [n.n_nfse, n.status, n.competencia, n.tomador_nome, n.tomador_documento, num(n.valor_servico).replace('.', ','), n.chave_acesso].map(csv).join(';'))].join('\r\n'));
  }
  if (o.entradas || o.sefaz) entradasDoPeriodo(empresaId, o.de, o.ate, arq, !!o.entradas, !!o.sefaz);
  if (o.ofx) {
    arq[`extrato/movimentacao_${o.de}_${o.ate}.ofx`] = strToU8(gerarOfx(empresaId, o.de, o.ate));
    const mv = movimentos(empresaId, o.de, o.ate);
    arq['extrato/movimentacao.csv'] = strToU8('﻿' + [['Data', 'Tipo', 'Valor', 'Histórico'].map(csv).join(';'), ...mv.map((m) => [m.data.split('-').reverse().join('/'), m.tipo === 'CREDIT' ? 'Entrada' : 'Saída', num(m.valor).replace('.', ','), m.historico].map(csv).join(';'))].join('\r\n'));
  }
  if (!Object.keys(arq).length) throw new ErroNegocio('Nada encontrado no período escolhido.', 404);
  const limpo = String(emp.razao_social).normalize('NFD').replace(/[^\w]+/g, '_').slice(0, 30);
  return { zip: Buffer.from(zipSync(arq, { level: 6 })), nome: `contabilidade_${limpo}_${o.de}_${o.ate}.zip` };
}

// ---------------------------------------------------------------------------
// E-mail da contabilidade e fechamento mensal automático
// ---------------------------------------------------------------------------
export const ConfigFechamento = z.object({
  emails: z.string().trim().max(400).default(''),
  ativo: z.boolean().default(false),
  dia: z.number().int().min(1, 'Escolha um dia de 1 a 28').max(28, 'Escolha um dia de 1 a 28').nullish(),
});

const listaEmails = (texto: string | null | undefined) => (texto ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

export function configFechamento(empresaId: number) {
  const e = db.prepare('SELECT contabilidade_email AS emails, fechamento_ativo AS ativo, fechamento_dia AS dia, fechamento_ultimo AS ultimo, fechamento_em AS em, fechamento_resultado AS resultado FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!e) throw new ErroNegocio('Empresa não encontrada.', 404);
  return { emails: e.emails ?? '', ativo: !!e.ativo, dia: e.dia ?? null, ultimo: e.ultimo ?? null, em: e.em ?? null, resultado: e.resultado ?? null };
}

export function salvarFechamento(empresaId: number, d: z.infer<typeof ConfigFechamento>) {
  const lista = listaEmails(d.emails);
  if (lista.length) { const r = ListaEmails.safeParse(lista); if (!r.success) throw new ErroNegocio(r.error.issues[0].message); }
  if (d.ativo && !lista.length) throw new ErroNegocio('Informe o e-mail da contabilidade para ligar o envio automático.');
  if (d.ativo && !d.dia) throw new ErroNegocio('Escolha o dia do mês para o envio.');
  if (!configFechamento(empresaId)) return;
  db.prepare('UPDATE empresas SET contabilidade_email = ?, fechamento_ativo = ?, fechamento_dia = ? WHERE id = ?').run(lista.join(', ') || null, d.ativo ? 1 : 0, d.dia ?? null, empresaId);
}

const ultimoDia = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

/** Mês fechado que o envio de `hoje` cobre: sempre o mês anterior (AAAA-MM). */
export function mesAnterior(hoje: string): string {
  const [a, m] = hoje.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

/** Gera o pacote completo do mês e envia para o e-mail da contabilidade. */
export async function enviarFechamento(empresaId: number, mes: string) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErroNegocio('Mês inválido.');
  const emp = db.prepare('SELECT id, escritorio_id, razao_social, nome_fantasia, documento, email, contabilidade_email FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!emp) throw new ErroNegocio('Empresa não encontrada.', 404);
  const para = listaEmails(emp.contabilidade_email);
  if (!para.length) throw new ErroNegocio('Informe o e-mail da contabilidade antes de enviar.');
  const [a, m] = mes.split('-').map(Number);
  const de = `${mes}-01`, ate = `${mes}-${String(ultimoDia(a, m)).padStart(2, '0')}`;
  const rotulo = `${String(m).padStart(2, '0')}/${a}`;
  try {
    const r = await pacoteContabilidade(empresaId, { de, ate, xml: true, pdf: true, ofx: true, entradas: true, sefaz: true });
    const { unzipSync } = await import('fflate');
    const nomes = Object.keys(unzipSync(new Uint8Array(r.zip)));
    const conta = (pref: string) => nomes.filter((n) => n.startsWith(pref) && !n.endsWith('.csv')).length;
    const resumo = [`Notas de serviço emitidas (XML): ${conta('notas/xml/')}`, `Notas de entrada (XML): ${conta('entradas/xml/')}`, `Extrato/movimentação: ${nomes.some((n) => n.startsWith('extrato/')) ? 'incluído' : 'sem movimentação'}`];
    await enviarPacoteContabilidade(emp.escritorio_id, para, emp, rotulo, r.zip, r.nome, resumo);
    db.prepare("UPDATE empresas SET fechamento_ultimo = ?, fechamento_em = datetime('now'), fechamento_resultado = ? WHERE id = ?").run(mes, `Enviado para ${para.join(', ')}`, empresaId);
    return { ok: true, mes, para };
  } catch (e) {
    db.prepare("UPDATE empresas SET fechamento_em = datetime('now'), fechamento_resultado = ? WHERE id = ?").run(`Falha: ${(e as Error).message}`.slice(0, 300), empresaId);
    throw e;
  }
}

/**
 * Chamado de tempos em tempos pelo servidor: a partir do dia escolhido, envia o fechamento do mês anterior uma vez por mês
 * (se o sistema estava fechado no dia, envia na primeira verificação depois). Em caso de falha tenta de novo após 6 horas.
 */
export async function fechamentoAutomatico(hoje = hojeBr()): Promise<number> {
  const mes = mesAnterior(hoje), dia = Number(hoje.slice(8, 10));
  const candidatas = db.prepare(`SELECT id, fechamento_dia, fechamento_ultimo, fechamento_em, fechamento_resultado FROM empresas
    WHERE fechamento_ativo = 1 AND fechamento_dia IS NOT NULL AND contabilidade_email IS NOT NULL`).all() as any[];
  let enviados = 0;
  for (const c of candidatas) {
    if (dia < c.fechamento_dia || c.fechamento_ultimo === mes) continue;
    const falhou = String(c.fechamento_resultado ?? '').startsWith('Falha') && c.fechamento_em;
    if (falhou && Date.now() - Date.parse(c.fechamento_em.replace(' ', 'T') + 'Z') < 6 * 3600e3) continue;
    try { await enviarFechamento(c.id, mes); enviados++; } catch { /* o motivo fica gravado em fechamento_resultado */ }
  }
  return enviados;
}
