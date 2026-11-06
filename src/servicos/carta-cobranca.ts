import PDFDocument from 'pdfkit';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { COR, MM, brl, cabecalho, dataBr, docFmt, emitenteDaEmpresa, rodapes, secao } from '../pdf/timbrado.js';

/**
 * Carta de cobrança (aviso de inadimplência) de um cliente, no papel timbrado da empresa: todas as cobranças vencidas
 * e não pagas desse cliente, com a estimativa de multa e juros até hoje pelas regras de cada cobrança.
 */
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function dadosCartaCobranca(empresaId: number, tomadorId: number, hoje = hojeBr()) {
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ? AND empresa_id = ?').get(tomadorId, empresaId) as any;
  if (!t) throw new ErroNegocio('Cliente não encontrado.', 404);
  const l = db.prepare(`SELECT id, descricao, vencimento, valor, multa_pct, juros_pct_mes, forma, linha_digitavel, pix_copia_cola FROM cobrancas
    WHERE empresa_id = ? AND tomador_id = ? AND status NOT IN ('PAGO','CANCELADO') AND vencimento < ? ORDER BY vencimento`).all(empresaId, tomadorId, hoje) as any[];
  const titulos = l.map((c) => {
    const atraso = Math.round((Date.parse(hoje) - Date.parse(c.vencimento)) / 864e5);
    const multa = r2(c.valor * (Number(c.multa_pct ?? t.multa_pct ?? 0) / 100));
    const juros = r2(c.valor * (Number(c.juros_pct_mes ?? t.juros_pct_mes ?? 0) / 100 / 30) * atraso);
    return { ...c, atraso, multa, juros, atualizado: r2(c.valor + multa + juros) };
  });
  return {
    hoje, cliente: { nome: t.nome, documento: t.documento ?? '', endereco: [[t.logradouro, t.numero ? `nº ${t.numero}` : null].filter(Boolean).join(', '), t.complemento, t.bairro, t.cidade ? `${t.cidade}${t.uf ? '/' + t.uf : ''}` : null].filter(Boolean).join(', ') },
    titulos, total: r2(titulos.reduce((s, x) => s + x.valor, 0)), totalAtualizado: r2(titulos.reduce((s, x) => s + x.atualizado, 0)),
  };
}

export function cartaCobrancaPdf(empresaId: number, tomadorId: number): Promise<{ pdf: Buffer; nome: string }> {
  const d = dadosCartaCobranca(empresaId, tomadorId);
  if (!d.titulos.length) throw new ErroNegocio('Este cliente não tem cobranças vencidas em aberto.');
  const em = emitenteDaEmpresa(empresaId);
  return new Promise((ok, falha) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Carta de cobrança - ${d.cliente.nome}` } });
    const partes: Buffer[] = []; pdf.on('data', (b) => partes.push(b)); pdf.on('error', falha);
    pdf.on('end', () => ok({ pdf: Buffer.concat(partes), nome: `Carta_Cobranca_${d.cliente.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').slice(0, 40)}_${d.hoje}.pdf` }));
    const X = 16 * MM, W = pdf.page.width - 2 * X, LIM = pdf.page.height - 22 * MM;
    const txt = (t: string, x: number, y: number, o: any = {}) => pdf.fillColor(o.cor ?? COR.texto).font(o.negrito ? 'Helvetica-Bold' : o.italico ? 'Helvetica-Oblique' : 'Helvetica').fontSize(o.tam ?? 9).text(t, x, y, { width: o.w, align: o.align, lineGap: o.lg ?? 0, lineBreak: o.quebra ?? true });
    let y = cabecalho(pdf, em, { titulo: 'Aviso de cobrança', subtitulo: `${em.endereco.split(', ').at(-1) || ''}${em.endereco ? ', ' : ''}${dataBr(d.hoje)}` });

    // destinatário
    pdf.rect(X, y, W, 20 * MM).fillAndStroke(COR.fundo, COR.linha);
    txt('DESTINATÁRIO', X + 4 * MM, y + 3.5 * MM, { cor: COR.destaque, negrito: true, tam: 8 });
    txt(d.cliente.nome, X + 4 * MM, y + 8 * MM, { negrito: true, tam: 10, w: W - 8 * MM });
    txt([d.cliente.documento ? `${String(d.cliente.documento).replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ'}: ${docFmt(d.cliente.documento)}` : '', d.cliente.endereco].filter(Boolean).join('  ·  '), X + 4 * MM, pdf.y + 1, { cor: '#333', tam: 8, w: W - 8 * MM });
    y += 20 * MM + 7 * MM;

    txt('Prezado(a) cliente,', X, y, { tam: 9.5 }); y = pdf.y + 3 * MM;
    txt(`Até a data desta carta não identificamos o pagamento ${d.titulos.length > 1 ? `das ${d.titulos.length} cobranças relacionadas abaixo` : 'da cobrança relacionada abaixo'}, no valor original de ${brl(d.total)}. `
      + 'Pedimos a gentileza de regularizar o quanto antes. Se o pagamento já foi feito, por favor desconsidere este aviso e, se possível, envie-nos o comprovante para darmos a baixa.',
      X, y, { tam: 9.5, w: W, align: 'justify', lg: 2 });
    y = pdf.y + 6 * MM;

    y = secao(pdf, 'Cobranças vencidas em aberto', X, y);
    const cols = [{ n: 'Vencimento', w: 0.13 }, { n: 'Descrição', w: 0.33 }, { n: 'Dias', w: 0.07, r: true }, { n: 'Valor', w: 0.12, r: true }, { n: 'Multa', w: 0.1, r: true }, { n: 'Juros', w: 0.1, r: true }, { n: 'Atualizado', w: 0.15, r: true }];
    const cab = () => {
      pdf.rect(X, y, W, 6.5 * MM).fill(COR.claro); pdf.moveTo(X, y + 6.5 * MM).lineTo(X + W, y + 6.5 * MM).lineWidth(1).stroke(COR.destaque);
      let x = X; for (const c of cols) { txt(c.n, x + 3, y + 2 * MM, { negrito: true, tam: 7.8, w: c.w * W - 6, align: c.r ? 'right' : 'left', quebra: false }); x += c.w * W; }
      y += 6.5 * MM + 1.5;
    };
    cab();
    for (const c of d.titulos) {
      pdf.font('Helvetica').fontSize(8);
      const h = pdf.heightOfString(c.descricao ?? '', { width: 0.33 * W - 6 }) + 5;
      if (y + h > LIM) { pdf.addPage({ size: 'A4', margin: 0 }); y = 14 * MM; cab(); }
      const v = [dataBr(c.vencimento), c.descricao ?? '', String(c.atraso), brl(c.valor), brl(c.multa), brl(c.juros), brl(c.atualizado)];
      let x = X; v.forEach((s, i) => { txt(s, x + 3, y + 2.2, { tam: 8, w: cols[i].w * W - 6, align: cols[i].r ? 'right' : 'left' }); x += cols[i].w * W; });
      y += h; pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.4).stroke(COR.linha);
    }
    if (y + 30 * MM > LIM) { pdf.addPage({ size: 'A4', margin: 0 }); y = 14 * MM; }
    y += 3;
    pdf.rect(X, y, W, 10 * MM).fill(COR.escuro);
    txt('TOTAL ATUALIZADO ATÉ HOJE (ESTIMADO)', X + 4 * MM, y + 3.6 * MM, { cor: '#fff', negrito: true, tam: 9 });
    txt(brl(d.totalAtualizado), X + W - 64 * MM, y + 2.6 * MM, { cor: '#fff', negrito: true, tam: 13, w: 60 * MM, align: 'right' });
    y += 10 * MM + 5 * MM;
    txt('Multa e juros calculados pelas regras de cada cobrança, até a data desta carta. O valor exato é o do boleto ou do Pix no dia do pagamento. Para receber a 2ª via ou combinar o pagamento, fale conosco'
      + (em.contato ? ` (${em.contato}).` : '.'), X, y, { tam: 8, cor: COR.cinza, w: W, italico: true, lg: 1.5 });
    y = pdf.y + 14 * MM;
    if (y + 20 * MM > LIM) { pdf.addPage({ size: 'A4', margin: 0 }); y = 30 * MM; }
    txt('Atenciosamente,', X, y, { tam: 9.5 });
    pdf.moveTo(X + W / 2 - 40 * MM, y + 18 * MM).lineTo(X + W / 2 + 40 * MM, y + 18 * MM).lineWidth(0.6).stroke(COR.cinza);
    txt(em.nome, X, y + 20 * MM, { negrito: true, tam: 9, w: W, align: 'center' });
    if (em.documento) txt(`CNPJ: ${docFmt(em.documento)}`, X, pdf.y, { tam: 8, cor: COR.cinza, w: W, align: 'center' });
    rodapes(pdf, em);
    pdf.end();
  });
}
