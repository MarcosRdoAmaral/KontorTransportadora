import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

/**
 * Modelos dos e-mails que o Kontor manda. Cada um tem assunto e texto editáveis, com campos automáticos
 * entre chaves duplas ({{cliente}}, {{valor}}...). Regras simples, para qualquer pessoa usar:
 *  - linha em branco separa parágrafos;
 *  - **texto** sai em negrito;
 *  - campo de lista (ex.: {{boletos}}) sozinho na linha vira um quadro com os itens;
 *  - se um campo estiver vazio para aquele envio, a linha em que ele está não é enviada.
 * Sem personalização, vale o texto sugerido (que pode ser restaurado a qualquer momento).
 */
export interface ItemLista { rotulo: string; valor?: string | null; detalhe?: string | null }
export type Valor = string | number | null | undefined | ItemLista[];
export type Variaveis = Record<string, Valor>;
interface Campo { nome: string; descricao: string; exemplo: Valor; lista?: boolean }
interface Modelo { chave: string; grupo: string; nome: string; descricao: string; campos: Campo[]; assunto: string; corpo: string }

const DESTINATARIO: Campo[] = [
  { nome: 'saudacao', descricao: 'Olá, com o nome do cliente quando houver', exemplo: 'Olá, Padaria Pão Dourado!' },
  { nome: 'cliente', descricao: 'Nome do cliente que recebe', exemplo: 'Padaria Pão Dourado' },
  { nome: 'emitente', descricao: 'Empresa que emitiu (a sua)', exemplo: 'Horizonte Serviços Ltda' },
  { nome: 'remetente', descricao: 'Nome do remetente (Configurações > E-mail)', exemplo: 'Horizonte Serviços' },
];
const COMPETENCIA: Campo[] = [
  { nome: 'competencia', descricao: 'Competência (MM/AAAA)', exemplo: '10/2026' },
  { nome: 'mes', descricao: 'Mês por extenso', exemplo: 'outubro de 2026' },
];
const NOTA: Campo[] = [
  { nome: 'numero', descricao: 'Número da NFS-e', exemplo: '128' },
  { nome: 'valor', descricao: 'Valor', exemplo: 'R$ 850,00' },
  { nome: 'competencia', descricao: 'Competência da nota', exemplo: '01/10/2026' },
  { nome: 'chave', descricao: 'Chave de acesso', exemplo: '42061520...' },
  { nome: 'link', descricao: 'Endereço da consulta pública', exemplo: 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=...' },
];

export const MODELOS: Modelo[] = [
  {
    chave: 'nota', grupo: 'Faturamento', nome: 'NFS-e emitida', descricao: 'Nota enviada ao cliente (na emissão ou pelo faturamento automático).',
    campos: [...DESTINATARIO, ...NOTA, { nome: 'boletos', descricao: 'Quadro com boletos ou Pix (quando vão junto)', lista: true,
      exemplo: [{ rotulo: 'Boleto', valor: 'R$ 850,00', detalhe: 'Vencimento 10/11/2026 · Linha digitável 23790.00000 00000.000000 00000.000000 1 00000000085000' }] }],
    assunto: 'NFS-e nº {{numero}} — {{emitente}}',
    corpo: `{{saudacao}}

Segue a Nota Fiscal de Serviço eletrônica (NFS-e) **nº {{numero}}**, emitida por {{emitente}}, no valor de **{{valor}}** (competência {{competencia}}).

{{boletos}}

Em anexo estão o PDF (DANFSe) e o arquivo XML da nota. Você também pode consultá-la em {{link}}

Qualquer dúvida, é só responder este e-mail.

Um abraço,
{{remetente}}`,
  },
  {
    chave: 'nota_cancelada', grupo: 'Faturamento', nome: 'NFS-e cancelada', descricao: 'Aviso de cancelamento de nota ao cliente.',
    campos: [...DESTINATARIO, ...NOTA, { nome: 'motivo', descricao: 'Motivo do cancelamento', exemplo: 'Erro no valor do serviço' }],
    assunto: 'NFS-e nº {{numero}} CANCELADA — {{emitente}}',
    corpo: `{{saudacao}}

Informamos que a NFS-e **nº {{numero}}**, emitida por {{emitente}} no valor de {{valor}} (competência {{competencia}}), foi **cancelada** e não tem mais validade fiscal.
Motivo: {{motivo}}

Pode desconsiderar o documento anterior. Se uma nova nota for emitida, ela chega em seguida.

Em anexo estão o PDF marcado como cancelado e os XMLs da nota e do cancelamento. Consulta: {{link}}

Um abraço,
{{remetente}}`,
  },
  {
    chave: 'boleto', grupo: 'Faturamento', nome: 'Boleto de cobrança', descricao: 'Boleto enviado sem nota (quando o cliente não recebe NFS-e).',
    campos: [...DESTINATARIO, { nome: 'referencia', descricao: 'Mês de referência (MM/AAAA)', exemplo: '10/2026' }, { nome: 'valor', descricao: 'Valor', exemplo: 'R$ 850,00' },
      { nome: 'vencimento', descricao: 'Vencimento', exemplo: '10/11/2026' }, { nome: 'linha_digitavel', descricao: 'Linha digitável', exemplo: '23790.00000 00000.000000 00000.000000 1 00000000085000' }],
    assunto: 'Boleto com vencimento em {{vencimento}} — {{emitente}}',
    corpo: `{{saudacao}}

Seguem em anexo o boleto de **{{valor}}**, com vencimento em **{{vencimento}}**, e o demonstrativo da cobrança, emitidos por {{emitente}}.

Se preferir, pague pela linha digitável: {{linha_digitavel}}

Se o pagamento já foi feito, desconsidere esta mensagem. Obrigado pela parceria!

Um abraço,
{{remetente}}`,
  },
  {
    chave: 'pix', grupo: 'Faturamento', nome: 'Cobrança por Pix', descricao: 'Demonstrativo com QR Code Pix, para os clientes da carteira Pix.',
    campos: [...DESTINATARIO, { nome: 'referencia', descricao: 'Mês de referência (MM/AAAA)', exemplo: '10/2026' }, { nome: 'valor', descricao: 'Valor', exemplo: 'R$ 225,00' },
      { nome: 'vencimento', descricao: 'Vencimento', exemplo: '10/11/2026' }, { nome: 'pix_copia_cola', descricao: 'Código Pix copia e cola', exemplo: '00020126580014br.gov.bcb.pix0136...6304ABCD' }],
    assunto: 'Cobrança Pix com vencimento em {{vencimento}} — {{emitente}}',
    corpo: `{{saudacao}}

Segue em anexo o demonstrativo da cobrança de {{emitente}}, no valor de **{{valor}}**, com vencimento em **{{vencimento}}**.

O pagamento é por Pix: escaneie o QR Code do demonstrativo no aplicativo do seu banco ou use o Pix copia e cola abaixo.
{{pix_copia_cola}}

Se o pagamento já foi feito, desconsidere esta mensagem. Obrigado pela parceria!

Um abraço,
{{remetente}}`,
  },
  {
    chave: 'pacote', grupo: 'Contabilidade', nome: 'Fechamento para a contabilidade', descricao: 'Pacote mensal (ZIP) enviado ao e-mail da contabilidade da empresa.',
    campos: [{ nome: 'saudacao', descricao: 'Olá!', exemplo: 'Olá!' }, { nome: 'empresa', descricao: 'Nome da empresa', exemplo: 'Horizonte Serviços' },
      { nome: 'razao_social', descricao: 'Razão social', exemplo: 'Horizonte Serviços Ltda' }, { nome: 'cnpj', descricao: 'CNPJ', exemplo: '13.269.205/0001-19' },
      { nome: 'remetente', descricao: 'Nome do remetente (Configurações > E-mail)', exemplo: 'Horizonte Serviços' }, ...COMPETENCIA,
      { nome: 'resumo', descricao: 'Quadro com o que vai no pacote', lista: true, exemplo: [{ rotulo: 'Notas de serviço emitidas (XML)', valor: '42' }, { rotulo: 'Notas de entrada (XML)', valor: '17' }] }],
    assunto: 'Fechamento {{competencia}} — {{empresa}}',
    corpo: `{{saudacao}}

Segue o fechamento de {{mes}} da **{{razao_social}}** ({{cnpj}}):

{{resumo}}

O pacote completo vai em anexo (ZIP). Qualquer ajuste, é só avisar.

Um abraço,
{{remetente}}`,
  },
];

const porChave = new Map(MODELOS.map((m) => [m.chave, m]));
const definicao = (chave: string) => { const m = porChave.get(chave); if (!m) throw new ErroNegocio('Modelo de e-mail desconhecido.', 404); return m; };

export function lerModelo(chave: string) {
  const m = definicao(chave);
  const r = db.prepare('SELECT assunto, corpo, atualizado_em FROM email_modelos WHERE chave = ?').get(chave) as any;
  return { assunto: r?.assunto ?? m.assunto, corpo: r?.corpo ?? m.corpo, personalizado: !!r, atualizado_em: r?.atualizado_em ?? null };
}
export function listarModelos() {
  return MODELOS.map((m) => ({ chave: m.chave, grupo: m.grupo, nome: m.nome, descricao: m.descricao, campos: m.campos.map(({ nome, descricao, lista }) => ({ nome, descricao, lista: !!lista })),
    padrao: { assunto: m.assunto, corpo: m.corpo }, ...lerModelo(m.chave) }));
}
export const ModeloEditado = z.object({ assunto: z.string().trim().min(1, 'O assunto não pode ficar vazio.').max(200), corpo: z.string().max(8000).refine((v) => v.trim().length > 0, 'O texto não pode ficar vazio.') });

export function camposDesconhecidos(chave: string, texto: string) {
  const m = definicao(chave);
  return [...new Set([...texto.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((x) => x[1]).filter((n) => !m.campos.some((c) => c.nome === n)))];
}
export function salvarModelo(chave: string, d: z.infer<typeof ModeloEditado>) {
  const m = definicao(chave);
  const desc = camposDesconhecidos(chave, `${d.assunto}\n${d.corpo}`);
  if (desc.length) throw new ErroNegocio(`Campo que não existe neste e-mail: ${desc.map((n) => `{{${n}}}`).join(', ')}. Use os campos da lista ao lado.`);
  if (d.assunto === m.assunto && d.corpo === m.corpo) return restaurarModelo(chave);
  db.prepare(`INSERT INTO email_modelos (chave, assunto, corpo) VALUES (?,?,?)
    ON CONFLICT(chave) DO UPDATE SET assunto = excluded.assunto, corpo = excluded.corpo, atualizado_em = datetime('now')`).run(chave, d.assunto, d.corpo);
  return { ok: true };
}
export function restaurarModelo(chave: string) {
  definicao(chave);
  db.prepare('DELETE FROM email_modelos WHERE chave = ?').run(chave);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
const escHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const vazio = (v: Valor) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
const TAG = /\{\{\s*(\w+)\s*\}\}/g;

/** Texto e HTML a partir do modelo (o salvo, ou o enviado pela tela para a prévia). */
export function renderizar(chave: string, vars: Variaveis, editado?: { assunto: string; corpo: string }) {
  definicao(chave);
  const mod = editado ?? lerModelo(chave);
  const v: Variaveis = { ...vars };
  if (vazio(v.saudacao)) v.saudacao = v.cliente ? `Olá, ${v.cliente}!` : 'Olá!';
  const texto = (s: string) => s.replace(TAG, (_x, n) => { const x = v[n]; return Array.isArray(x) ? '' : String(x ?? ''); });
  const assunto = texto(mod.assunto).replace(/\s+/g, ' ').replace(/^[\s|·—-]+|[\s|·—-]+$/g, '').trim();

  type Parte = { tipo: 'p'; linhas: string[] } | { tipo: 'lista'; itens: ItemLista[] };
  const partes: Parte[] = [];
  let atual: string[] = [];
  const fecha = () => { if (atual.length) partes.push({ tipo: 'p', linhas: atual }); atual = []; };
  for (const linha of mod.corpo.replace(/\r/g, '').split('\n')) {
    if (!linha.trim()) { fecha(); continue; }
    const so = /^\s*\{\{\s*(\w+)\s*\}\}\s*$/.exec(linha);
    if (so && Array.isArray(v[so[1]])) { fecha(); if ((v[so[1]] as ItemLista[]).length) partes.push({ tipo: 'lista', itens: v[so[1]] as ItemLista[] }); continue; }
    if ([...linha.matchAll(TAG)].some((x) => vazio(v[x[1]]))) continue;
    atual.push(texto(linha));
  }
  fecha();

  const linhasTexto: string[] = [];
  for (const p of partes) {
    if (linhasTexto.length) linhasTexto.push('');
    if (p.tipo === 'p') linhasTexto.push(...p.linhas.map((l) => l.replace(/\*\*(.+?)\*\*/g, '$1')));
    else for (const i of p.itens) linhasTexto.push(`• ${i.rotulo}${i.valor ? `: ${i.valor}` : ''}${i.detalhe ? ` · ${i.detalhe}` : ''}`);
  }
  const negrito = (s: string) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb;word-break:break-all">$1</a>');
  const corpoHtml = partes.map((p) => p.tipo === 'p'
    ? `<p style="margin:0 0 16px;overflow-wrap:anywhere;word-break:break-word">${p.linhas.map(negrito).join('<br>')}</p>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;background:#f9fafb">${p.itens.map((i, k) =>
      `<tr><td style="padding:12px 16px;${k ? 'border-top:1px solid #e5e7eb;' : ''}vertical-align:top"><div style="font-weight:600;color:#111827">${escHtml(i.rotulo)}</div>${i.detalhe ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;overflow-wrap:anywhere">${escHtml(i.detalhe)}</div>` : ''}</td>` +
      `<td style="padding:12px 16px;${k ? 'border-top:1px solid #e5e7eb;' : ''}text-align:right;vertical-align:top;white-space:nowrap;font-weight:700;color:#111827;font-size:16px">${i.valor ? escHtml(i.valor) : ''}</td></tr>`).join('')}</table>`).join('');
  const html = `<div style="margin:0;padding:24px 12px;background:#f3f4f6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate">
<tr><td style="padding:32px 36px 20px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#374151">${corpoHtml}<!--assinatura--></td></tr></table></td></tr></table></div>`;
  return { assunto, linhas: linhasTexto, html, texto: linhasTexto.join('\n') };
}

/** Valores de exemplo, para a prévia e o e-mail de teste. */
export const exemplo = (chave: string): Variaveis => Object.fromEntries(definicao(chave).campos.map((c) => [c.nome, c.exemplo]));

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** AAAA-MM → { competencia: 'MM/AAAA', mes: 'outubro de 2026' } */
export const camposMes = (mes: string) => ({ competencia: `${mes.slice(5, 7)}/${mes.slice(0, 4)}`, mes: `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}` });
export const moeda = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const dataBr = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
