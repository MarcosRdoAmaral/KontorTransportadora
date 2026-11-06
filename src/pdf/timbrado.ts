import { db } from '../db.js';

/**
 * Papel timbrado dos documentos do Kontor (demonstrativo, relatórios, situação fiscal, carta de cobrança):
 * faixa no topo, logo ou nome do escritório, CNPJ, endereço e contato, título e, em todas as páginas, rodapé com o
 * nome do escritório, a frase do rodapé e a numeração.
 */
export const MM = 72 / 25.4;
/** Paleta do produto (a mesma do tema padrão do sistema): `escuro` nas faixas e títulos, `destaque` nos títulos de seção e detalhes. */
export const COR = { escuro: '#161616', destaque: '#e0650f', claro: '#fdeedf', suave: '#fbb27a', cinza: '#5b6472', fundo: '#f5f5f4', linha: '#e2e2e0', texto: '#1f2937' };
export interface Emitente { nome: string; documento: string; endereco: string; contato: string; logo: Buffer | null; rodape: string | null }

export const docFmt = (d: string) => { const x = String(d ?? '').replace(/\D/g, ''); return x.length === 14 ? x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : x.length === 11 ? x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : String(d ?? ''); };
export const brl = (v: number) => `R$ ${(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dataBr = (iso?: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

/** Dados do escritório (a empresa emitente) para o cabeçalho. */
export function emitenteDaEmpresa(empresaId: number): Emitente {
  const e = (db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any) ?? {};
  const endereco = [[e.logradouro, e.numero ? `nº ${e.numero}` : null].filter(Boolean).join(', '), e.bairro, e.cidade ? `${e.cidade}${e.uf ? '/' + e.uf : ''}` : null].filter(Boolean).join(', ');
  const fone = e.contato_fone ? `WhatsApp: ${e.contato_fone}` : null;
  return {
    nome: e.nome_fantasia || e.razao_social || '', documento: e.documento ?? '', endereco,
    contato: [e.email, fone].filter(Boolean).join(' | '), logo: e.logo ? Buffer.from(e.logo) : null, rodape: e.demonstrativo_rodape ?? null,
  };
}
/** Cabeçalho na página atual; devolve o y livre logo abaixo. `compacto` = logo à esquerda e dados ao lado (relatórios). */
export function cabecalho(pdf: PDFKit.PDFDocument, em: Emitente, o: { titulo: string; subtitulo?: string; compacto?: boolean }): number {
  const PW = pdf.page.width, X = 16 * MM, W = PW - 2 * X;
  pdf.rect(0, 0, PW, 3 * MM).fill(COR.escuro);
  pdf.rect(0, 0, 32 * MM, 3 * MM).fill(COR.destaque);
  let y = 10 * MM;
  const linhaDados = [em.documento ? `CNPJ: ${docFmt(em.documento)}` : '', em.endereco].filter(Boolean).join(' | ');
  if (o.compacto) {
    let xt = X;
    if (em.logo) { try { pdf.image(em.logo, X, y, { fit: [42 * MM, 14 * MM], valign: 'center' }); xt = X + 46 * MM; } catch { /* sem logo */ } }
    const wt = W - (xt - X) - 90 * MM;
    pdf.fillColor(COR.escuro).font('Helvetica-Bold').fontSize(11).text(em.nome, xt, y + 1, { width: wt, lineBreak: false, ellipsis: true });
    pdf.fillColor(COR.cinza).font('Helvetica').fontSize(7).text(linhaDados, xt, y + 5.5 * MM, { width: wt, lineBreak: false, ellipsis: true });
    if (em.contato) pdf.text(em.contato, xt, y + 9 * MM, { width: wt, lineBreak: false, ellipsis: true });
    pdf.fillColor(COR.escuro).font('Helvetica-Bold').fontSize(15).text(o.titulo.toUpperCase(), X + W - 88 * MM, y, { width: 88 * MM, align: 'right' });
    if (o.subtitulo) pdf.fillColor(COR.cinza).font('Helvetica').fontSize(8).text(o.subtitulo, X + W - 88 * MM, pdf.y + 1, { width: 88 * MM, align: 'right' });
    y = Math.max(y + 15 * MM, pdf.y + 2 * MM);
    pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.8).stroke(COR.linha);
    return y + 4 * MM;
  }
  if (em.logo) {
    try { pdf.image(em.logo, PW / 2 - 35 * MM, y, { fit: [70 * MM, 18 * MM], align: 'center', valign: 'center' }); y += 20 * MM; } catch { em = { ...em, logo: null }; }
  }
  if (!em.logo) { pdf.fillColor(COR.escuro).font('Helvetica-Bold').fontSize(16).text(em.nome, X, y, { width: W, align: 'center' }); y = pdf.y + 2 * MM; }
  pdf.fillColor(COR.cinza).font('Helvetica').fontSize(7.5).text(linhaDados, X, y, { width: W, align: 'center' });
  if (em.contato) pdf.text(em.contato, X, pdf.y, { width: W, align: 'center' });
  y = pdf.y + 5 * MM;
  pdf.fillColor(COR.escuro).font('Helvetica-Bold').fontSize(18).text(o.titulo.toUpperCase(), X, y, { width: W, align: 'center' });
  if (o.subtitulo) pdf.fillColor(COR.cinza).font('Helvetica').fontSize(8.5).text(o.subtitulo, X, pdf.y, { width: W, align: 'center' });
  return pdf.y + 5 * MM;
}

/** Rodapé em todas as páginas (o PDF precisa ser criado com bufferPages: true). */
export function rodapes(pdf: PDFKit.PDFDocument, em: Emitente) {
  const faixa = pdf.bufferedPageRange();
  for (let i = faixa.start; i < faixa.start + faixa.count; i++) {
    pdf.switchToPage(i);
    const PW = pdf.page.width, PH = pdf.page.height, X = 16 * MM, W = PW - 2 * X, y = PH - 11 * MM;
    pdf.moveTo(X, y - 2.5 * MM).lineTo(X + W, y - 2.5 * MM).lineWidth(0.6).stroke(COR.linha);
    pdf.fillColor(COR.cinza).font('Helvetica').fontSize(7)
      .text([em.nome.toUpperCase(), em.rodape].filter(Boolean).join('  •  '), X, y, { width: W - 40 * MM, lineBreak: false, ellipsis: true })
      .text(`Página ${i - faixa.start + 1} de ${faixa.count}`, X + W - 40 * MM, y, { width: 40 * MM, align: 'right', lineBreak: false });
  }
}

/** Título de seção (texto em vermelho, como no demonstrativo). */
export function secao(pdf: PDFKit.PDFDocument, titulo: string, x: number, y: number) {
  pdf.fillColor(COR.destaque).font('Helvetica-Bold').fontSize(8.5).text(titulo.toUpperCase(), x, y);
  return pdf.y + 2 * MM;
}
