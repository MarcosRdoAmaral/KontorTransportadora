import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { CONSULTA_PUBLICA_URL } from '../config.js';
import type { NfseLida } from './leitura.js';

const OP_SIMP: Record<string, string> = { '1': 'Não optante', '2': 'Optante - Microempreendedor Individual (MEI)', '3': 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)' };
const REG_AP_SN: Record<string, string> = {
  '1': 'Regime de apuração dos tributos federais e municipal pelo SN',
  '2': 'Regime de apuração dos tributos federais pelo SN e o ISSQN pela NFS-e conforme legislação municipal',
  '3': 'Regime de apuração dos tributos federais e municipal pela NFS-e conforme legislações federal e municipal',
};
const TRIB_ISSQN: Record<string, string> = { '1': 'Operação Tributável', '2': 'Imunidade', '3': 'Exportação de serviço', '4': 'Não Incidência' };
const RET_ISSQN: Record<string, string> = { '1': 'Não Retido', '2': 'Retido pelo Tomador', '3': 'Retido pelo Intermediário' };
const EMITENTE: Record<string, string> = { '1': 'Prestador', '2': 'Tomador', '3': 'Intermediário' };
const RET_PISCOFINS: Record<string, string> = {
  '0': 'PIS/COFINS/CSLL Não Retidos', '1': 'PIS/COFINS Retidos', '2': 'PIS/COFINS Não Retidos', '3': 'PIS/COFINS/CSLL Retidos',
  '4': 'PIS/COFINS Retidos, CSLL Não Retido', '5': 'PIS Retido, COFINS/CSLL Não Retido', '6': 'COFINS Retido, PIS/CSLL Não Retido',
  '7': 'PIS Não Retido, COFINS/CSLL Retidos', '8': 'PIS/COFINS Não Retidos, CSLL Retido', '9': 'COFINS Não Retido, PIS/CSLL Retidos',
};
const PIS_RETIDO = new Set(['1', '3', '4', '5', '9']);
const COFINS_RETIDO = new Set(['1', '3', '4', '6', '7']);

const brl = (n?: number) => (n === undefined ? '-' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (n?: number) => (n === undefined ? '-' : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`);
const dataBr = (s?: string) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '-');
const dataHoraBr = (s?: string) => (s ? `${dataBr(s)} ${s.slice(11, 19)}` : '-');
const ou = (s?: string | number | null) => (s === undefined || s === null || s === '' ? '-' : String(s));

export function formatarDoc(d?: string): string {
  if (!d) return '-';
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return d;
}
const fmtCep = (c?: string) => (c && c.length === 8 ? `${c.slice(0, 2)}.${c.slice(2, 5)}-${c.slice(5)}` : ou(c));
const fmtIbge = (c?: string) => (c && c.length === 7 ? `${c.slice(0, 2)}.${c.slice(2)}` : ou(c));
const fmtTribNac = (c?: string) => (c && c.length === 6 ? `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4)}` : ou(c));
const fmtNbs = (c?: string) => (c && c.length === 9 ? `${c[0]}.${c.slice(1, 5)}.${c.slice(5, 7)}.${c.slice(7)}` : ou(c));
const fmtFone = (f?: string) => {
  const d = (f ?? '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return ou(f);
};
const endereco = (e?: { xLgr: string; nro: string; xCpl?: string; xBairro: string }) =>
  e ? `${e.xLgr}, ${e.nro}${e.xCpl ? ', ' + e.xCpl : ''}, ${e.xBairro}` : '-';

interface Celula { l?: string; v?: string; w: number; titulo?: boolean; destaque?: boolean }

/**
 * Gera o DANFSe em PDF (layout DANFSe v2.0 do Emissor Nacional) a partir do XML autorizado.
 */
export async function gerarDanfse(n: NfseLida, opcoes: { cancelada?: boolean; logo?: Buffer | null } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 24, info: { Title: `DANFSe ${n.numero}` } });
  const partes: Buffer[] = [];
  doc.on('data', (c) => partes.push(c));
  const fim = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(partes))));

  const X0 = 24;
  const L = doc.page.width - 48;
  let y = 24;

  /** Uma linha de células: rótulo em negrito pequeno e valor abaixo. */
  const linha = (cels: Celula[], largura = L) => {
    let h = 0;
    for (const c of cels) {
      const w = largura * c.w - 8;
      doc.font('Helvetica-Bold').fontSize(c.titulo ? 8 : 6.5);
      const hl = c.l ? doc.heightOfString(c.l, { width: w }) : 0;
      doc.font('Helvetica').fontSize(8);
      const hv = c.v ? doc.heightOfString(c.v, { width: w }) : 0;
      h = Math.max(h, hl + hv + 6);
    }
    h = Math.max(h, 20);
    let x = X0;
    for (const c of cels) {
      const w = largura * c.w;
      if (c.titulo || c.destaque) doc.rect(x, y, w, h).fill('#e9e9e9');
      doc.fillColor('#000');
      const yl = y + 3;
      doc.font('Helvetica-Bold').fontSize(c.titulo ? 8 : 6.5).text(c.l ?? '', x + 4, yl, { width: w - 8 });
      if (c.v) {
        const hl = c.l ? doc.heightOfString(c.l, { width: w - 8 }) : 0;
        doc.font('Helvetica').fontSize(8).text(c.v, x + 4, yl + hl, { width: w - 8 });
      }
      x += w;
    }
    y += h;
  };
  const traco = (esp = 0.7) => { doc.moveTo(X0, y).lineTo(X0 + L, y).lineWidth(esp).stroke('#000'); };

  // ---------- Cabeçalho ----------
  doc.rect(X0, y, L, 44).fill('#eeeeee').fillColor('#000');
  let xTitulo = X0;
  if (opcoes.logo) {
    try { doc.image(opcoes.logo, X0 + 6, y + 4, { fit: [110, 36], align: 'center', valign: 'center' }); } catch { /* sem logo */ }
  } else {
    doc.fillColor('#1d6f3a').font('Helvetica-Bold').fontSize(22).text('NFS-e', X0 + 8, y + 7);
    doc.fillColor('#555').font('Helvetica').fontSize(6.5).text('Nota Fiscal de Serviço eletrônica', X0 + 8, y + 32);
    doc.fillColor('#000');
  }
  doc.font('Helvetica-Bold').fontSize(11).text('DANFSe v2.0', xTitulo + 150, y + 10, { width: L - 330, align: 'center' });
  doc.fontSize(10).text('Documento Auxiliar da NFS-e', xTitulo + 150, y + 24, { width: L - 330, align: 'center' });
  doc.font('Helvetica').fontSize(9).text(`Município: ${n.xLocEmi ?? '-'}`, X0 + L - 170, y + 6, { width: 164 });
  doc.fontSize(6.5).text(`Ambiente Gerador: ${ou(n.ambGer)}`, X0 + L - 170, y + 20, { width: 164 });
  doc.text(`Tipo de Ambiente: ${n.tpAmb}`, X0 + L - 170, y + 29, { width: 164 });
  y += 44;
  traco();
  if (n.tpAmb === 2) {
    doc.fillColor('#b00').font('Helvetica-Bold').fontSize(8).text('NFS-e emitida em ambiente de testes (produção restrita) — SEM VALOR FISCAL', X0, y + 3, { width: L, align: 'center' });
    doc.fillColor('#000');
    y += 14;
  }

  // ---------- Identificação (QR à direita) ----------
  const yId = y;
  const LW = L - 150;
  linha([{ l: 'CHAVE DE ACESSO DA NFS-e', v: n.chave, w: 1 }], LW);
  linha([{ l: 'NÚMERO DA NFS-e', v: n.numero, w: 0.3 }, { l: 'COMPETÊNCIA DA NFS-e', v: dataBr(n.dps.dCompet), w: 0.3 }, { l: 'DATA E HORA DA EMISSÃO DA NFS-e', v: dataHoraBr(n.dhProc), w: 0.4 }], LW);
  linha([{ l: 'NÚMERO DA DPS', v: n.dps.nDPS, w: 0.3 }, { l: 'SÉRIE DA DPS', v: n.dps.serie, w: 0.3 }, { l: 'DATA E HORA DA EMISSÃO DA DPS', v: dataHoraBr(n.dps.dhEmi), w: 0.4 }], LW);
  linha([
    { l: 'EMITENTE DA NFS-e', v: EMITENTE[n.dps.tpEmit ?? '1'] ?? '-', w: 0.3 },
    { l: 'SITUAÇÃO DA NFS-e', v: opcoes.cancelada ? 'NFS-e Cancelada' : 'NFS-e Gerada', w: 0.3 },
    { l: 'FINALIDADE', v: 'NFS-e regular', w: 0.4 },
  ], LW);
  const qr = await QRCode.toBuffer(CONSULTA_PUBLICA_URL + n.chave, { margin: 0, width: 220 });
  doc.image(qr, X0 + L - 108, yId + 4, { width: 58 });
  doc.font('Helvetica').fontSize(5.5).text('A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e', X0 + L - 146, yId + 66, { width: 142 });
  if (y < yId + 92) y = yId + 92;
  traco();

  // ---------- Prestador ----------
  const e = n.emitente;
  linha([{ l: 'PRESTADOR / FORNECEDOR', w: 0.25, titulo: true }, { l: 'CNPJ / CPF / NIF', v: formatarDoc(e.documento), w: 0.25 }, { l: 'Indicador Municipal (Inscrição)', v: ou(e.im), w: 0.25 }, { l: 'Telefone', v: fmtFone(e.fone), w: 0.25 }]);
  linha([{ l: 'Nome / Nome Empresarial', v: e.nome, w: 0.5 }, { l: 'Município / Sigla UF', v: e.end ? `${n.xLocEmi ?? '-'} / ${e.end.UF}` : '-', w: 0.25 }, { l: 'Código IBGE / CEP', v: e.end ? `${fmtIbge(e.end.cMun)} / ${fmtCep(e.end.CEP)}` : '-', w: 0.25 }]);
  linha([{ l: 'Endereço', v: endereco(e.end), w: 0.5 }, { l: 'E-mail', v: ou(e.email), w: 0.5 }]);
  linha([{ l: 'Simples Nacional na Data de Competência', v: OP_SIMP[n.dps.opSimpNac] ?? '-', w: 0.5 }, { l: 'Regime de Apuração Tributária pelo SN', v: n.dps.opSimpNac === '3' ? REG_AP_SN[n.dps.regApTribSN ?? '1'] ?? '-' : '-', w: 0.5 }]);
  traco();

  // ---------- Tomador ----------
  const t = n.tomador;
  if (t) {
    const mesmoMun = t.end?.cMun && t.end.cMun === e.end?.cMun;
    linha([{ l: 'TOMADOR / ADQUIRENTE', w: 0.25, titulo: true }, { l: 'CNPJ / CPF / NIF', v: formatarDoc(t.documento), w: 0.25 }, { l: 'Indicador Municipal (Inscrição)', v: ou(t.im), w: 0.25 }, { l: 'Telefone', v: fmtFone(t.fone), w: 0.25 }]);
    linha([{ l: 'Nome / Nome Empresarial', v: t.nome, w: 0.5 }, { l: 'Município / Sigla UF', v: t.end ? (mesmoMun ? `${n.xLocEmi} / ${e.end?.UF}` : '-') : '-', w: 0.25 }, { l: 'Código IBGE / CEP', v: t.end ? `${fmtIbge(t.end.cMun)} / ${fmtCep(t.end.CEP)}` : '-', w: 0.25 }]);
    linha([{ l: 'Endereço', v: endereco(t.end), w: 0.5 }, { l: 'E-mail', v: ou(t.email), w: 0.5 }]);
  } else {
    linha([{ l: 'TOMADOR / ADQUIRENTE', w: 0.25, titulo: true }, { v: 'TOMADOR DO SERVIÇO NÃO IDENTIFICADO NA NFS-e', w: 0.75 }]);
  }
  traco(0.4);
  doc.font('Helvetica').fontSize(8).text('DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', X0, y + 2, { width: L, align: 'center' }); y += 12; traco(0.4);
  doc.text('INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', X0, y + 2, { width: L, align: 'center' }); y += 12; traco();

  // ---------- Serviço ----------
  linha([
    { l: 'SERVIÇO PRESTADO', w: 0.25, titulo: true },
    { l: 'Código de Tributação Nacional/Municipal', v: `${fmtTribNac(n.servico.cTribNac)} / ${ou(n.servico.cTribMun)}`, w: 0.25 },
    { l: 'Código da NBS', v: fmtNbs(n.servico.cNBS), w: 0.25 },
    { l: 'Local da Prestação / Sigla UF / País', v: `${ou(n.xLocPrestacao)} / ${e.end?.UF ?? '-'} / -`, w: 0.25 },
  ]);
  if (n.xTribNac) { doc.font('Helvetica').fontSize(8).text(n.xTribNac, X0 + 4, y + 3, { width: L - 8 }); y += doc.heightOfString(n.xTribNac, { width: L - 8 }) + 7; }
  linha([{ l: 'Descrição do Serviço', v: n.servico.descricao, w: 1 }]);
  traco();

  // ---------- Tributação municipal ----------
  const v = n.valores;
  linha([{ l: 'TRIBUTAÇÃO MUNICIPAL (ISSQN)', w: 0.25, titulo: true }, { l: 'Tipo de Tributação do ISSQN', v: TRIB_ISSQN[v.tribISSQN] ?? '-', w: 0.25 }, { l: 'Município / Sigla UF / País de Incidência do ISSQN', v: `${ou(n.xLocIncid ?? n.xLocPrestacao)} / ${e.end?.UF ?? '-'} / -`, w: 0.5 }]);
  linha([{ l: 'BC ISSQN', v: brl(v.vBC), w: 0.25 }, { l: 'Alíquota Aplicada', v: v.pAliq !== undefined ? pct(v.pAliq) : '-', w: 0.25 }, { l: 'Retenção do ISSQN', v: RET_ISSQN[v.tpRetISSQN] ?? '-', w: 0.25 }, { l: 'ISSQN Apurado', v: brl(v.vISSQN), w: 0.25 }]);
  traco();

  // ---------- Tributação federal ----------
  const pisRet = PIS_RETIDO.has(v.tpRetPisCofins ?? '') ? v.vPis ?? 0 : 0;
  const cofRet = COFINS_RETIDO.has(v.tpRetPisCofins ?? '') ? v.vCofins ?? 0 : 0;
  const contribRet = Math.round((pisRet + cofRet + (v.vRetCSLL ?? 0)) * 100) / 100;
  linha([{ l: 'TRIBUTAÇÃO FEDERAL (EXCETO CBS)', w: 0.25, titulo: true }, { l: 'IRRF', v: brl(v.vRetIRRF), w: 0.25 }, { l: 'Contribuição Previdenciária - Retida', v: brl(v.vRetCP), w: 0.25 }, { l: 'Contribuições Sociais - Retidas', v: contribRet ? brl(contribRet) : '-', w: 0.25 }]);
  linha([{ l: 'PIS - Débito Apuração Própria', v: brl(v.vPis), w: 0.25 }, { l: 'COFINS - Débito Apuração Própria', v: brl(v.vCofins), w: 0.25 }, { l: 'Descrição Contrib. Sociais - Retidas', v: v.tpRetPisCofins !== undefined ? `${v.tpRetPisCofins} - ${RET_PISCOFINS[v.tpRetPisCofins] ?? ''}` : '-', w: 0.5 }]);
  traco();

  // ---------- IBS / CBS ----------
  const ib = n.ibscbs;
  if (ib) {
    const excl = ib.vBC !== undefined ? Math.round((v.vServ - ib.vBC) * 100) / 100 : undefined;
    const trio = (a?: number, b?: number, c?: number) => [a, b, c].map((x) => (x === undefined ? '-' : pct(x))).join(' / ');
    linha([
      { l: 'TRIBUTAÇÃO IBS/CBS', w: 0.25, titulo: true },
      { l: 'CST / cClassTrib', v: `${ou(ib.cst)} / ${ou(ib.cClassTrib)}`, w: 0.25 },
      { l: 'Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF', v: `${ou(ib.cIndOp)} / ${ou(ib.cLocIncid)} / ${ou(ib.xLocIncid)} / ${e.end?.UF ?? '-'}`, w: 0.5 },
    ]);
    linha([
      { l: 'Exclusões e Reduções da Base de Cálculo', v: brl(excl), w: 0.25 },
      { l: 'Base de Cálculo Após Exclusões e Reduções', v: brl(ib.vBC), w: 0.25 },
      { l: 'Red. Alíquota IBS UF / IBS Mun / CBS', v: trio(ib.pRedAliqUF, ib.pRedAliqMun, ib.pRedAliqCBS).replace(/ %/g, ' %'), w: 0.25 },
      { l: 'Alíquota - IBS UF / IBS Mun', v: `${ib.pIBSUF === undefined ? '-' : pct(ib.pIBSUF)} / ${ib.pIBSMun === undefined ? '-' : pct(ib.pIBSMun)}`, w: 0.25 },
    ]);
    linha([
      { l: 'Alíq. Efetiva Municipal - IBS', v: ib.pAliqEfetMun === undefined ? '-' : pct(ib.pAliqEfetMun), w: 0.25 },
      { l: 'Valor Apurado Municipal - IBS', v: brl(ib.vIBSMun), w: 0.25 },
      { l: 'Alíq. Efetiva Estadual - IBS', v: ib.pAliqEfetUF === undefined ? '-' : pct(ib.pAliqEfetUF), w: 0.25 },
      { l: 'Valor Apurado Estadual - IBS', v: brl(ib.vIBSUF), w: 0.25 },
    ]);
    linha([
      { l: 'Valor Total Apurado - IBS', v: brl(ib.vIBSTot), w: 0.25 },
      { l: 'Alíquota - CBS', v: ib.pCBS === undefined ? '-' : pct(ib.pCBS), w: 0.25 },
      { l: 'Alíquota Efetiva - CBS', v: ib.pAliqEfetCBS === undefined ? '-' : pct(ib.pAliqEfetCBS), w: 0.25 },
      { l: 'Valor Total Apurado - CBS', v: brl(ib.vCBS), w: 0.25 },
    ]);
    traco();
  }

  // ---------- Totais ----------
  const ibsCbsTotal = ib ? Math.round(((ib.vIBSTot ?? 0) + (ib.vCBS ?? 0)) * 100) / 100 : undefined;
  linha([{ l: 'VALOR TOTAL DA NFS-e', w: 0.25, titulo: true }, { l: 'VALOR DA OPERAÇÃO / SERVIÇO', v: brl(v.vServ), w: 0.25 }, { l: 'Desconto Incondicionado', v: brl(v.vDescIncond), w: 0.25 }, { l: 'Desconto Condicionado', v: brl(v.vDescCond), w: 0.25 }]);
  linha([
    { l: 'Total das Retenções (ISSQN / Federais)', v: brl(v.vTotalRet), w: 0.25 },
    { l: 'VALOR LÍQUIDO DA NFS-e', v: brl(v.vLiq), w: 0.25 },
    { l: 'Total do IBS/CBS', v: brl(ibsCbsTotal), w: 0.25 },
    { l: 'VALOR LÍQUIDO DA NFS-e + IBS/CBS', v: brl(v.vLiq), w: 0.25, destaque: true },
  ]);
  traco();

  // ---------- Informações complementares ----------
  linha([{ l: 'INFORMAÇÕES COMPLEMENTARES', w: 1, titulo: true }]);
  const compl = [n.servico.infoCompl, n.xOutInf].filter(Boolean).join('\n');
  const aprox = v.pTotTribSN !== undefined
    ? `Valor aproximado dos tributos (Simples Nacional): ${pct(v.pTotTribSN)}`
    : v.pTotTrib ? `Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: ${pct(v.pTotTrib.fed)}; Estaduais: ${pct(v.pTotTrib.est)}; Municipais: ${pct(v.pTotTrib.mun)};` : '';
  const textoCompl = [compl, compl.includes('12.741') ? '' : aprox].filter(Boolean).join('\n');
  doc.font('Helvetica').fontSize(8).text(textoCompl || '-', X0 + 4, y + 6, { width: L - 8 });

  // ---------- Rodapé ----------
  const yr = doc.page.height - 24 - 40;
  doc.rect(X0, yr, L, 40).lineWidth(1).stroke('#000');
  const col = [0.3, 0.3, 0.4];
  const rot = ['DATA CIENTIFICAÇÃO:', 'IDENTIFICAÇÃO E ASSINATURA', 'N° NFS-e / CHAVE NFS-e'];
  let xr = X0;
  rot.forEach((r, i) => {
    const w = L * col[i];
    if (i) doc.moveTo(xr, yr).lineTo(xr, yr + 40).lineWidth(0.5).stroke('#000');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(6.5).text(r, xr + 4, yr + 4, { width: w - 8 });
    if (i === 2) doc.font('Helvetica').fontSize(6.8).text(`${n.numero} / ${n.chave}`, xr + 4, yr + 14, { width: w - 8 });
    xr += w;
  });

  if (opcoes.cancelada) {
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fillColor('#c00').opacity(0.25).font('Helvetica-Bold').fontSize(90).text('CANCELADA', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore();
  }

  doc.end();
  return fim;
}
