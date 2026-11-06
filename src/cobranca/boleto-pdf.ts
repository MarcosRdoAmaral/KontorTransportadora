import PDFDocument from 'pdfkit';
import { barrasItf } from './ailos.js';

export interface DadosBoleto {
  beneficiario: { nome: string; documento: string; endereco?: string };
  agenciaCodigo: string;          // "0101-5 / 903306-8"
  pagador: { nome: string; documento: string; endereco: string };
  nossoNumero: string;
  numeroDocumento: string;
  vencimento: string;             // AAAA-MM-DD
  valor: number;
  emissao: string;
  carteira: string;
  instrucoes: string[];
  linhaDigitavel: string;
  codigoBarras: string;
  /** Identificação do banco impressa no boleto (vem do módulo da integração). */
  banco: { nome: string; subtitulo: string; localPagamento: string };
}

const MM = 72 / 25.4;
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (iso: string) => iso.split('-').reverse().join('/');
const doc = (d: string) => { const x = d.replace(/\D/g, ''); return x.length === 14 ? x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : x.length === 11 ? x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d; };

export function gerarBoletoPdf(b: DadosBoleto): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Boleto ${b.numeroDocumento}` } });
    const partes: Buffer[] = [];
    pdf.on('data', (c) => partes.push(c)); pdf.on('end', () => resolve(Buffer.concat(partes))); pdf.on('error', reject);

    const X = 12 * MM, W = 186 * MM;
    const campo = (rot: string, val: string, x: number, y: number, w: number, h = 9 * MM, alinhar: 'left' | 'right' = 'left', negrito = false) => {
      pdf.rect(x, y, w, h).lineWidth(0.5).stroke('#000');
      pdf.fillColor('#444').font('Helvetica').fontSize(5.5).text(rot, x + 1.5, y + 1.5, { width: w - 3 });
      pdf.fillColor('#000').font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(val, x + 2, y + h - 11.5, { width: w - 4, align: alinhar, lineBreak: false });
    };
    const cabecalho = (y: number, titulo: string, comLinha: boolean) => {
      pdf.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(b.banco.nome, X, y + 6, { lineBreak: false });
      pdf.fontSize(5.5).font('Helvetica').text(b.banco.subtitulo, X, y + 21, { lineBreak: false });
      pdf.moveTo(X + 36 * MM, y).lineTo(X + 36 * MM, y + 10 * MM).lineWidth(1.2).stroke('#000');
      pdf.moveTo(X + 50 * MM, y).lineTo(X + 50 * MM, y + 10 * MM).stroke('#000');
      pdf.font('Helvetica-Bold').fontSize(13).text('085-0', X + 38 * MM, y + 8, { lineBreak: false });
      if (comLinha) pdf.fontSize(11).text(b.linhaDigitavel, X + 52 * MM, y + 9, { lineBreak: false });
      else pdf.fontSize(12).text(titulo, X + 52 * MM, y + 8, { width: W - 52 * MM, align: 'right', lineBreak: false });
    };

    // -------- Recibo do pagador --------
    let y = 14 * MM;
    pdf.font('Helvetica').fontSize(6).fillColor('#444').text('Linha digitável para uso no internet banking', X, y - 8, { lineBreak: false });
    pdf.fillColor('#000').font('Helvetica-Bold').fontSize(10).text(b.linhaDigitavel, X, y + 1, { lineBreak: false });
    y += 14;
    cabecalho(y, 'RECIBO DO PAGADOR', false); y += 10 * MM;
    campo('Beneficiário', b.beneficiario.nome, X, y, 98 * MM); campo('Agência / Código do Beneficiário', b.agenciaCodigo, X + 98 * MM, y, 38 * MM);
    campo('Nosso número', b.nossoNumero, X + 136 * MM, y, 50 * MM, 9 * MM, 'right'); y += 9 * MM;
    campo('Número do documento', b.numeroDocumento, X, y, 40 * MM); campo('CNPJ/CPF do beneficiário', doc(b.beneficiario.documento), X + 40 * MM, y, 58 * MM);
    campo('Vencimento', dataBr(b.vencimento), X + 98 * MM, y, 38 * MM, 9 * MM, 'right', true); campo('Valor do documento', brl(b.valor), X + 136 * MM, y, 50 * MM, 9 * MM, 'right', true); y += 9 * MM;
    campo('Pagador', `${b.pagador.nome} — ${doc(b.pagador.documento)}`, X, y, W); y += 9 * MM;
    pdf.rect(X, y, W, 16 * MM).stroke('#000');
    pdf.fillColor('#444').fontSize(5.5).font('Helvetica').text('Informações', X + 2, y + 2);
    pdf.fillColor('#000').fontSize(8).text(b.instrucoes.slice(0, 4).join('\n'), X + 3, y + 9, { width: W - 6 });
    y += 18 * MM;
    pdf.dash(3, { space: 3 }).moveTo(X, y).lineTo(X + W, y).lineWidth(0.5).stroke('#000').undash();
    y += 10;

    // -------- Ficha de compensação --------
    cabecalho(y, '', true); y += 10 * MM;
    const w = (mm: number) => mm * MM;
    campo('Local de pagamento', b.banco.localPagamento, X, y, w(136)); campo('Vencimento', dataBr(b.vencimento), X + w(136), y, w(50), w(9), 'right', true); y += w(9);
    campo('Beneficiário', b.beneficiario.nome, X, y, w(98)); campo('CNPJ/CPF', doc(b.beneficiario.documento), X + w(98), y, w(38)); campo('Agência / Código do Beneficiário', b.agenciaCodigo, X + w(136), y, w(50), w(9), 'right'); y += w(9);
    campo('Data do documento', dataBr(b.emissao), X, y, w(30)); campo('Nº do documento', b.numeroDocumento, X + w(30), y, w(32)); campo('Espécie doc.', 'DS', X + w(62), y, w(22));
    campo('Aceite', 'N', X + w(84), y, w(14)); campo('Data do processamento', dataBr(b.emissao), X + w(98), y, w(38)); campo('Nosso número', b.nossoNumero, X + w(136), y, w(50), w(9), 'right'); y += w(9);
    campo('Uso do banco', '', X, y, w(30)); campo('Carteira', b.carteira, X + w(30), y, w(20)); campo('Espécie', 'R$', X + w(50), y, w(20)); campo('Quantidade', '', X + w(70), y, w(28)); campo('Valor', '', X + w(98), y, w(38));
    campo('(=) Valor do documento', brl(b.valor), X + w(136), y, w(50), w(9), 'right', true); y += w(9);
    const hInstr = w(38);
    pdf.rect(X, y, w(136), hInstr).stroke('#000');
    pdf.fillColor('#444').fontSize(5.5).font('Helvetica').text('Instruções (texto de responsabilidade do beneficiário)', X + 2, y + 2);
    pdf.fillColor('#000').fontSize(8.5).text(b.instrucoes.join('\n'), X + 3, y + 10, { width: w(130) });
    for (const [i, r] of ['(-) Desconto / Abatimento', '(-) Outras deduções', '(+) Mora / Multa', '(+) Outros acréscimos', '(=) Valor cobrado'].entries()) {
      campo(r, '', X + w(136), y + i * (hInstr / 5), w(50), hInstr / 5);
    }
    y += hInstr;
    pdf.rect(X, y, W, w(16)).lineWidth(0.5).stroke('#000');
    pdf.fillColor('#444').font('Helvetica').fontSize(5.5).text('Pagador', X + 1.5, y + 1.5);
    pdf.fillColor('#000').fontSize(8.5).text(`${b.pagador.nome} — ${doc(b.pagador.documento)}`, X + 3, y + 10, { width: W - 6, lineBreak: false });
    pdf.text(b.pagador.endereco, X + 3, y + 22, { width: W - 6 });
    y += w(16) + 4;
    pdf.fontSize(6).fillColor('#444').text('Autenticação mecânica — FICHA DE COMPENSAÇÃO', X, y, { width: W, align: 'right' });
    y += 12;

    // -------- Código de barras (13 mm × 103 mm, 2 de 5 intercalado) --------
    const barras = barrasItf(b.codigoBarras);
    const modulo = (103 * MM) / barras.reduce((a, n) => a + n, 0);
    let x = X; let preto = true;
    for (const n of barras) { if (preto) pdf.rect(x, y, n * modulo, 13 * MM).fill('#000'); x += n * modulo; preto = !preto; }
    pdf.end();
  });
}
