import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { COR } from '../pdf/timbrado.js';
import { barrasItf } from './ailos.js';

/** Demonstrativo de cobrança (A4): cabeçalho do escritório, cliente, serviços, total e a forma de pagamento (Pix ou boleto). */
export interface DadosDemonstrativo {
  emitente: { nome: string; documento: string; endereco: string; contato: string; logo?: Buffer | null };
  cliente: { nome: string; documento: string; endereco: string };
  referencia: string;              // MM/AAAA
  vencimento: string;              // AAAA-MM-DD
  itens: { descricao: string; qtd: number; valor: number }[];
  desconto?: { valor: number; motivo: string | null } | null;
  total: number;
  pix?: string | null;             // Pix copia e cola
  boleto?: { linhaDigitavel: string; codigoBarras: string } | null;
  rodape?: string | null;
}

const MM = 72 / 25.4;
/** Cores do produto (as mesmas dos relatórios: src/pdf/timbrado.ts). */
const AZUL = COR.escuro, VERMELHO = COR.destaque, CINZA = COR.cinza, FUNDO = COR.fundo, LINHA = COR.linha;
const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dataBr = (iso: string) => iso.split('-').reverse().join('/');
export const docFmt = (d: string) => { const x = String(d ?? '').replace(/\D/g, ''); return x.length === 14 ? x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : x.length === 11 ? x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : String(d ?? ''); };

export async function gerarDemonstrativoPdf(d: DadosDemonstrativo): Promise<Buffer> {
  const qr = d.pix ? await QRCode.toBuffer(d.pix, { errorCorrectionLevel: 'M', margin: 1, width: 360 }) : null;
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Demonstrativo de cobrança ${d.referencia} - ${d.cliente.nome}` } });
    const partes: Buffer[] = [];
    pdf.on('data', (c) => partes.push(c)); pdf.on('end', () => resolve(Buffer.concat(partes))); pdf.on('error', reject);
    const PW = 210 * MM, X = 18 * MM, W = PW - 2 * X;

    // faixa superior
    pdf.rect(0, 0, PW, 3 * MM).fill(AZUL);
    pdf.rect(0, 0, 32 * MM, 3 * MM).fill(VERMELHO);

    // cabeçalho do escritório
    let y = 12 * MM;
    if (d.emitente.logo) {
      try { pdf.image(d.emitente.logo, PW / 2 - 55 * MM, y, { fit: [110 * MM, 34 * MM], align: 'center', valign: 'center' }); y += 37 * MM; }
      catch { d.emitente.logo = null; }
    }
    if (!d.emitente.logo) { pdf.fillColor(AZUL).font('Helvetica-Bold').fontSize(16).text(d.emitente.nome, X, y, { width: W, align: 'center' }); y = pdf.y + 2 * MM; }
    pdf.fillColor(CINZA).font('Helvetica').fontSize(7.5);
    pdf.text([`CNPJ: ${docFmt(d.emitente.documento)}`, d.emitente.endereco].filter(Boolean).join(' | '), X, y, { width: W, align: 'center' });
    if (d.emitente.contato) pdf.text(d.emitente.contato, X, pdf.y, { width: W, align: 'center' });
    y = pdf.y + 5 * MM;

    pdf.fillColor(AZUL).font('Helvetica-Bold').fontSize(19).text('DEMONSTRATIVO DE COBRANÇA', X, y, { width: W, align: 'center' });
    pdf.fillColor(CINZA).font('Helvetica').fontSize(8.5).text(`Referência ${d.referencia}`, X, pdf.y, { width: W, align: 'center' });
    y = pdf.y + 5 * MM;

    // cliente e vencimento
    const hCli = 24 * MM;
    pdf.rect(X, y, W, hCli).fillAndStroke(FUNDO, LINHA);
    pdf.fillColor(VERMELHO).font('Helvetica-Bold').fontSize(8).text('CLIENTE', X + 4 * MM, y + 3.5 * MM);
    pdf.text('VENCIMENTO', X + W - 48 * MM, y + 3.5 * MM, { width: 44 * MM, align: 'right' });
    pdf.fillColor('#111').font('Helvetica-Bold').fontSize(9.5).text(d.cliente.nome, X + 4 * MM, y + 9 * MM, { width: W - 60 * MM });
    pdf.font('Helvetica').fontSize(8).fillColor('#333').text(`${d.cliente.documento.replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ'}: ${docFmt(d.cliente.documento)}`, X + 4 * MM, pdf.y + 1, { width: W - 60 * MM });
    if (d.cliente.endereco) pdf.text(d.cliente.endereco, X + 4 * MM, pdf.y, { width: W - 60 * MM });
    pdf.fillColor(AZUL).font('Helvetica-Bold').fontSize(14).text(dataBr(d.vencimento), X + W - 52 * MM, y + 12 * MM, { width: 48 * MM, align: 'right' });
    y += hCli + 7 * MM;

    // serviços
    pdf.fillColor(VERMELHO).font('Helvetica-Bold').fontSize(8.5).text('DISCRIMINAÇÃO DOS SERVIÇOS', X, y);
    y += 5 * MM;
    const cQtd = X + W - 50 * MM, cVal = X + W - 32 * MM;
    pdf.rect(X, y, W, 8 * MM).fill(COR.claro);
    pdf.moveTo(X, y + 8 * MM).lineTo(X + W, y + 8 * MM).lineWidth(1.2).stroke(VERMELHO);
    pdf.fillColor('#111').font('Helvetica-Bold').fontSize(8).text('Descrição', X + 3 * MM, y + 2.8 * MM).text('Qtd.', cQtd, y + 2.8 * MM, { width: 14 * MM, align: 'center' }).text('Valor', cVal, y + 2.8 * MM, { width: 29 * MM, align: 'right' });
    y += 8 * MM;
    const linhas = [...d.itens.map((i) => ({ ...i, desconto: false })), ...(d.desconto?.valor ? [{ descricao: `Desconto${d.desconto.motivo ? ` (${d.desconto.motivo})` : ''}`, qtd: 0, valor: -d.desconto.valor, desconto: true }] : [])];
    for (const it of linhas) {
      pdf.font('Helvetica').fontSize(8.5);
      const h = Math.max(pdf.heightOfString(it.descricao, { width: cQtd - X - 6 * MM }) + 5 * MM, 9 * MM);
      pdf.fillColor(it.desconto ? CINZA : '#222').text(it.descricao, X + 3 * MM, y + 3 * MM, { width: cQtd - X - 6 * MM });
      if (!it.desconto) pdf.text(String(it.qtd).padStart(2, '0'), cQtd, y + 3 * MM, { width: 14 * MM, align: 'center' });
      pdf.text(it.valor < 0 ? `- ${brl(-it.valor)}` : brl(it.valor), cVal, y + 3 * MM, { width: 29 * MM, align: 'right' });
      y += h;
      pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.6).stroke(LINHA);
    }
    y += 6 * MM;

    // total
    pdf.rect(X, y, W, 14 * MM).fill(AZUL);
    pdf.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('TOTAL A PAGAR', X + 5 * MM, y + 5.2 * MM);
    pdf.fontSize(17).text(brl(d.total), X + W - 85 * MM, y + 3.6 * MM, { width: 80 * MM, align: 'right' });
    y += 14 * MM + 6 * MM;

    // Pix
    if (d.pix && qr) {
      const h = 40 * MM;
      pdf.rect(X, y, W, h).fillAndStroke(FUNDO, LINHA);
      pdf.roundedRect(X + 5 * MM, y + 4 * MM, 32 * MM, 32 * MM, 3).fillAndStroke('#fff', LINHA);
      pdf.image(qr, X + 6.5 * MM, y + 5.5 * MM, { width: 29 * MM, height: 29 * MM });
      const tx = X + 44 * MM, tw = W - 48 * MM;
      pdf.fillColor(AZUL).font('Helvetica-Bold').fontSize(10).text('PAGAMENTO VIA PIX', tx, y + 5 * MM, { width: tw });
      pdf.fillColor('#222').font('Helvetica').fontSize(8).text('Escaneie o QR Code no aplicativo do seu banco ou use o Pix Copia e Cola abaixo.', tx, pdf.y + 2, { width: tw });
      pdf.font('Helvetica-Bold').fontSize(7.5).text('PIX COPIA E COLA:', tx, pdf.y + 4, { width: tw });
      pdf.font('Courier').fontSize(6.6).fillColor('#333').text(d.pix, tx, pdf.y + 1, { width: tw, lineGap: 0.5 });
      pdf.font('Helvetica').fontSize(7).fillColor(CINZA).text('Confira o valor e o favorecido antes de confirmar o pagamento.', tx, Math.min(pdf.y + 3, y + h - 6 * MM), { width: tw });
      y += h + 6 * MM;
    }

    // Boleto
    if (d.boleto) {
      const h = 34 * MM;
      pdf.save().roundedRect(X, y, W, h, 4).dash(3, { space: 2 }).lineWidth(0.8).stroke('#b9c2cc').restore();
      pdf.fillColor(AZUL).font('Helvetica-Bold').fontSize(9).text('PAGAMENTO VIA BOLETO BANCÁRIO', X + 5 * MM, y + 4 * MM);
      pdf.fillColor(CINZA).font('Helvetica').fontSize(7).text('Linha digitável', X + 5 * MM, y + 10 * MM);
      pdf.fillColor('#111').font('Helvetica-Bold').fontSize(10.5).text(d.boleto.linhaDigitavel, X + 5 * MM, y + 13.5 * MM, { width: W - 10 * MM });
      const barras = barrasItf(d.boleto.codigoBarras);
      const modulo = (103 * MM) / barras.reduce((a, n) => a + n, 0);
      let bx = X + 5 * MM, preto = true;
      for (const n of barras) { if (preto) pdf.rect(bx, y + 20 * MM, n * modulo, 11 * MM).fill('#000'); bx += n * modulo; preto = !preto; }
      pdf.fillColor(CINZA).font('Helvetica').fontSize(7).text('O boleto completo segue em anexo.', X + 112 * MM, y + 24 * MM, { width: W - 117 * MM, align: 'right' });
      y += h + 6 * MM;
    }

    pdf.fillColor(CINZA).font('Helvetica-Oblique').fontSize(8).text('Obrigado pela preferência.', X, y, { width: W, align: 'center' });

    // rodapé
    const yr = 285 * MM;
    pdf.moveTo(X, yr - 3 * MM).lineTo(X + W, yr - 3 * MM).lineWidth(0.6).stroke(LINHA);
    pdf.fillColor(CINZA).font('Helvetica').fontSize(7).text([d.emitente.nome.toUpperCase(), d.rodape].filter(Boolean).join('  •  '), X, yr, { width: W, align: 'center', lineBreak: false });
    pdf.end();
  });
}
