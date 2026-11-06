import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { db } from '../db.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { ErroNegocio, danfse } from './emissao.js';
import { obterOrcamento, orcamentoPdf } from './orcamentos.js';
import { camposDesconhecidos, camposMes, dataBr, exemplo as exemploDe, moeda, renderizar, type ItemLista } from './modelos-email.js';

export const ConfigSmtp = z.object({
  host: z.string().min(3, 'Informe o servidor SMTP'),
  port: z.number().int().min(1).max(65535),
  /** true = SSL direto (porta 465); false = STARTTLS (porta 587) */
  secure: z.boolean(),
  usuario: z.string().min(1, 'Informe o usuário'),
  /** Em branco ao editar = mantém a senha já salva. */
  senha: z.string().nullish(),
  remetente_nome: z.string().min(1, 'Informe o nome do remetente'),
  remetente_email: z.string().email('E-mail do remetente inválido'),
});
export type ConfigSmtp = z.infer<typeof ConfigSmtp>;
type ConfigSalva = Omit<ConfigSmtp, 'senha'> & { senha: string };

export const ListaEmails = z.array(z.string().trim().email('E-mail de destino inválido')).min(1, 'Informe ao menos um e-mail').max(5, 'No máximo 5 destinatários');

/** Permite trocar o transporte nos testes (sem rede). */
let fabrica: (c: ConfigSalva) => Transporter = (c) =>
  nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.usuario, pass: c.senha }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
export function trocarTransporte(f: typeof fabrica) { fabrica = f; }

function lerConfig(escritorioId: number): ConfigSalva | null {
  const r = db.prepare('SELECT smtp_enc FROM escritorios WHERE id = ?').get(escritorioId) as { smtp_enc: string | null } | undefined;
  return r?.smtp_enc ? (JSON.parse(decifrarTexto(r.smtp_enc)) as ConfigSalva) : null;
}

/** Configuração sem a senha (para a tela). */
export function configPublica(escritorioId: number) {
  const c = lerConfig(escritorioId);
  if (!c) return null;
  const { senha, ...resto } = c;
  return { ...resto, tem_senha: !!senha };
}

export function salvarConfig(escritorioId: number, nova: ConfigSmtp) {
  const atual = lerConfig(escritorioId);
  const senha = nova.senha || atual?.senha;
  if (!senha) throw new ErroNegocio('Informe a senha (ou senha de aplicativo) do e-mail.');
  const { senha: _ignora, ...resto } = nova;
  db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = ?').run(cifrarTexto(JSON.stringify({ ...resto, senha })), escritorioId);
}

function traduzirErro(e: any): string {
  const m = String(e?.message ?? e);
  if (/EAUTH|Invalid login|535|authentication/i.test(m)) return 'O servidor recusou o usuário/senha. No Gmail e no Outlook é preciso usar uma "senha de aplicativo".';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Servidor SMTP não encontrado. Confira o endereço e a conexão com a internet.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET/i.test(m)) return 'Não foi possível conectar ao servidor SMTP. Confira a porta e o tipo de segurança (SSL/STARTTLS).';
  return m;
}

export async function testarConfig(escritorioId: number, para: string) {
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Salve a configuração de e-mail antes de testar.');
  try {
    await fabrica(c).sendMail({
      from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para,
      subject: 'Teste de e-mail — Kontor Gestão Transportadora', text: 'Se você recebeu esta mensagem, o envio de NFS-e por e-mail está configurado corretamente.',
    });
  } catch (e) { throw new ErroNegocio(traduzirErro(e), 502); }
}

export function assinaturaDoEscritorio(escritorioId: number) {
  const r = db.prepare('SELECT assinatura_img, assinatura_mime FROM escritorios WHERE id = ?').get(escritorioId) as any;
  return r?.assinatura_img ? { img: Buffer.from(r.assinatura_img), mime: String(r.assinatura_mime || 'image/png') } : null;
}
export function salvarAssinatura(escritorioId: number, dataUrl: string | null) {
  if (!dataUrl) { db.prepare('UPDATE escritorios SET assinatura_img = NULL, assinatura_mime = NULL WHERE id = ?').run(escritorioId); return { ok: true }; }
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ErroNegocio('Envie a assinatura como imagem PNG, JPG ou GIF.');
  const img = Buffer.from(m[2], 'base64');
  if (img.length > 600 * 1024) throw new ErroNegocio('A imagem da assinatura passa de 600 KB. Use uma versão menor (até uns 800 pixels de largura).');
  db.prepare('UPDATE escritorios SET assinatura_img = ?, assinatura_mime = ? WHERE id = ?').run(img, m[1], escritorioId);
  return { ok: true };
}
/** Acrescenta a imagem de assinatura (se houver) ao final do e-mail. */
function assinar<T extends { html?: string; attachments?: any[] }>(escritorioId: number, m: T): T {
  const a = assinaturaDoEscritorio(escritorioId);
  if (!a) return { ...m, html: m.html?.replace('<!--assinatura-->', '') };
  const img = `<p style="margin:20px 0 0"><img src="cid:assinatura@kontor" alt="Assinatura" style="max-width:480px;width:100%;height:auto;display:block;border:0"></p>`;
  return { ...m, html: (m.html ?? '').replace('<!--assinatura-->', img),
    attachments: [...(m.attachments ?? []), { filename: `assinatura.${a.mime.split('/')[1].replace('jpeg', 'jpg')}`, content: a.img, contentType: a.mime, cid: 'assinatura@kontor', contentDisposition: 'inline' }] };
}

/** Prévia e e-mail de teste de um modelo (com os valores de exemplo ou o texto ainda não salvo). */
export function previaModelo(escritorioId: number, chave: string, editado?: { assunto: string; corpo: string }) {
  const r = renderizar(chave, { ...exemploDe(chave), remetente: lerConfig(escritorioId)?.remetente_nome ?? 'Sua empresa' }, editado);
  const a = assinaturaDoEscritorio(escritorioId);
  return { assunto: r.assunto, desconhecidos: editado ? camposDesconhecidos(chave, `${editado.assunto}\n${editado.corpo}`) : [], html: r.html.replace('<!--assinatura-->', a ? `<p style="margin:20px 0 0"><img src="data:${a.mime};base64,${a.img.toString('base64')}" alt="Assinatura" style="max-width:480px;width:100%;height:auto;display:block;border:0"></p>` : ''), texto: r.texto };
}
export async function enviarModeloTeste(escritorioId: number, chave: string, para: string, editado?: { assunto: string; corpo: string }) {
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Salve a configuração de e-mail antes de enviar um teste.');
  const r = renderizar(chave, { ...exemploDe(chave), remetente: c.remetente_nome }, editado);
  try { await fabrica(c).sendMail(assinar(escritorioId, { from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para, subject: `[TESTE] ${r.assunto}`, text: r.texto, html: r.html })); }
  catch (e) { throw new ErroNegocio(traduzirErro(e), 502); }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Envia a NFS-e (DANFSe em PDF + XML) para os destinatários e registra o resultado. */
export async function enviarNotaPorEmail(notaId: number, escritorioId: number, para: string[], usuarioId: number, tipo: 'emissao' | 'cancelamento' = 'emissao', adicional: { extras?: { filename: string; content: Buffer; contentType: string }[]; boletos?: ItemLista[] } = {}) {
  const nota = db.prepare(`SELECT n.*, e.razao_social, e.nome_fantasia, e.email AS empresa_email, e.escritorio_id
    FROM notas n JOIN empresas e ON e.id = n.empresa_id WHERE n.id = ?`).get(notaId) as any;
  if (!nota || nota.escritorio_id !== escritorioId) throw new ErroNegocio('Nota não encontrada.', 404);
  if (!nota.xml_nfse || !['AUTORIZADA', 'CANCELADA'].includes(nota.status)) throw new ErroNegocio('Só é possível enviar notas autorizadas.');
  if (nota.ambiente === 2) throw new ErroNegocio('Esta nota é de teste (produção restrita) e não pode ser enviada a clientes.');
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Configure o e-mail do escritório em E-mail antes de enviar.');

  if (tipo === 'cancelamento' && nota.status !== 'CANCELADA') throw new ErroNegocio('Esta nota não está cancelada.');
  const ev = tipo === 'cancelamento'
    ? (db.prepare(`SELECT motivo, xml_pedido FROM eventos WHERE nota_id = ? AND tipo = 'CANCELAMENTO' AND status NOT IN ('REJEITADO') ORDER BY id DESC LIMIT 1`).get(notaId) as { motivo: string | null; xml_pedido: string | null } | undefined)
    : undefined;
  const pdf = await danfse(notaId);
  const empresa = nota.nome_fantasia || nota.razao_social;
  const link = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${nota.chave_acesso}`;
  const msg = renderizar(tipo === 'cancelamento' ? 'nota_cancelada' : 'nota', {
    cliente: nota.tomador_nome, emitente: empresa, remetente: c.remetente_nome, numero: nota.n_nfse, valor: moeda(nota.valor_servico),
    competencia: dataBr(nota.competencia), chave: nota.chave_acesso, link, motivo: ev?.motivo, boletos: adicional.boletos ?? [],
  });
  const destino = para.join(', ');
  const registrar = (status: 'ENVIADO' | 'ERRO', erro?: string) =>
    db.prepare('INSERT INTO emails_enviados (nota_id, para, status, erro, enviado_por) VALUES (?,?,?,?,?)').run(notaId, destino, status, erro ?? null, usuarioId);
  try {
    await fabrica(c).sendMail(assinar(escritorioId, {
      from: `"${c.remetente_nome}" <${c.remetente_email}>`,
      to: destino,
      ...(nota.empresa_email ? { replyTo: nota.empresa_email } : {}),
      subject: msg.assunto,
      text: msg.texto,
      html: msg.html,
      attachments: [
        { filename: `DANFSe_${nota.n_nfse}.pdf`, content: pdf, contentType: 'application/pdf' },
        { filename: `NFSe_${nota.n_nfse}.xml`, content: nota.xml_nfse, contentType: 'application/xml; charset=utf-8' },
        ...(ev?.xml_pedido ? [{ filename: `Cancelamento_NFSe_${nota.n_nfse}.xml`, content: ev.xml_pedido, contentType: 'application/xml; charset=utf-8' }] : []),
        ...(adicional.extras ?? []),
      ],
    }));
  } catch (e) {
    const msg = traduzirErro(e);
    registrar('ERRO', msg);
    throw new ErroNegocio(msg, 502);
  }
  registrar('ENVIADO');
  return { ok: true, para: destino };
}

export function historicoEmails(notaId: number) {
  return db.prepare('SELECT id, para, status, erro, criado_em FROM emails_enviados WHERE nota_id = ? ORDER BY id DESC').all(notaId);
}

/** Código de uso único para redefinir a senha (tela de login). Silencioso se o e-mail do escritório não estiver configurado. */
export async function enviarCodigoRecuperacao(escritorioId: number, para: string, nome: string, codigo: string): Promise<boolean> {
  const c = lerConfig(escritorioId);
  if (!c) return false;
  const linhas = [`Olá, ${nome}!`, '', `Seu código para redefinir a senha do Kontor Gestão Transportadora é: ${codigo}`, '',
    'Ele vale por 15 minutos. Ao informá-lo na tela de login, sua senha volta para a senha padrão e o sistema pedirá que você crie uma nova.',
    'Se você não pediu isso, ignore esta mensagem: nada será alterado.'];
  try {
    await fabrica(c).sendMail({ from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para, subject: 'Código para redefinir sua senha — Kontor Gestão Transportadora', text: linhas.join('\n') });
    return true;
  } catch { return false; }
}

/** E-mail só com o boleto (quando o cliente não recebe nota). */
export async function enviarMensagemBoleto(escritorioId: number, para: string[], cob: any, tomador: any, anexos: { filename: string; content: Buffer; contentType: string }[]) {
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Configure o e-mail do escritório em E-mail antes de enviar.');
  const emp = db.prepare('SELECT e.razao_social, e.nome_fantasia, e.email FROM empresas e WHERE e.id = ?').get(cob.empresa_id) as any;
  const pix = cob.forma === 'PIX';
  const msg = renderizar(pix ? 'pix' : 'boleto', {
    cliente: tomador?.nome, emitente: emp.nome_fantasia || emp.razao_social, remetente: c.remetente_nome, referencia: cob.referencia,
    valor: moeda(cob.valor), vencimento: dataBr(cob.vencimento), linha_digitavel: cob.linha_digitavel, pix_copia_cola: cob.pix_copia_cola,
  });
  try {
    await fabrica(c).sendMail(assinar(escritorioId, {
      from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para.join(', '), ...(emp.email ? { replyTo: emp.email } : {}),
      subject: msg.assunto, text: msg.texto, html: msg.html, attachments: anexos,
    }));
  } catch (e) { throw new ErroNegocio(traduzirErro(e), 502); }
}

/** Fechamento mensal para a contabilidade: o pacote ZIP segue em anexo. */
export async function enviarPacoteContabilidade(escritorioId: number, para: string[], empresa: { razao_social: string; nome_fantasia?: string | null; documento: string; email?: string | null }, rotuloMes: string, zip: Buffer, nomeZip: string, resumo: string[]) {
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Configure o e-mail do escritório em E-mail antes de enviar o fechamento.');
  if (zip.length > 20 * 1024 * 1024) throw new ErroNegocio(`O pacote tem ${(zip.length / 1048576).toFixed(1)} MB, acima do que o e-mail aceita. Baixe pelo sistema e envie por outro meio.`);
  const mesIso = /^(\d{2})\/(\d{4})$/.test(rotuloMes) ? rotuloMes.replace(/^(\d{2})\/(\d{4})$/, '$2-$1') : null;
  const itens: ItemLista[] = resumo.map((l) => { const i = l.indexOf(': '); return i > 0 ? { rotulo: l.slice(0, i), valor: l.slice(i + 2) } : { rotulo: l }; });
  const msg = renderizar('pacote', { empresa: empresa.nome_fantasia || empresa.razao_social, razao_social: empresa.razao_social, cnpj: empresa.documento,
    remetente: c.remetente_nome, ...(mesIso ? camposMes(mesIso) : { competencia: rotuloMes, mes: rotuloMes }), resumo: itens });
  try {
    await fabrica(c).sendMail(assinar(escritorioId, {
      from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para.join(', '), ...(empresa.email ? { replyTo: empresa.email } : {}),
      subject: msg.assunto, text: msg.texto, html: msg.html,
      attachments: [{ filename: nomeZip, content: zip, contentType: 'application/zip' }],
    }));
  } catch (e) { throw new ErroNegocio(traduzirErro(e), 502); }
}

/** Orçamento em PDF para o cliente. Marca o orçamento como enviado. */
export async function enviarOrcamentoPorEmail(escritorioId: number, empresaId: number, orcamentoId: number, para: string[]) {
  const c = lerConfig(escritorioId);
  if (!c) throw new ErroNegocio('Configure o e-mail do escritório em E-mail antes de enviar.');
  const o = obterOrcamento(empresaId, orcamentoId);
  const emp = db.prepare('SELECT razao_social, nome_fantasia, email FROM empresas WHERE id = ?').get(empresaId) as any;
  const nome = emp.nome_fantasia || emp.razao_social;
  const { pdf, nome: arquivo } = await orcamentoPdf(empresaId, orcamentoId);
  const validade = o.validade ? ` O orçamento vale até ${dataBr(o.validade)}.` : '';
  const texto = `Olá${o.cliente ? `, ${o.cliente}` : ''}!\n\nSegue em anexo o orçamento nº ${o.numero}, no valor total de ${moeda(o.total)}.${validade}\n\nQualquer dúvida é só responder este e-mail.\n\n${nome}`;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  try {
    await fabrica(c).sendMail(assinar(escritorioId, {
      from: `"${c.remetente_nome}" <${c.remetente_email}>`, to: para.join(', '), ...(emp.email ? { replyTo: emp.email } : {}),
      subject: `Orçamento nº ${o.numero} - ${nome}`, text: texto, html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(texto).replace(/\n/g, '<br>')}</div>`,
      attachments: [{ filename: arquivo, content: pdf, contentType: 'application/pdf' }],
    }));
  } catch (e) { throw new ErroNegocio(traduzirErro(e), 502); }
}
