import { SignedXml } from 'xml-crypto';
import { XMLParser } from 'fast-xml-parser';
import type { CertificadoA1 } from '../nfse/certificado.js';
import { esc } from '../nfse/xml.js';

/**
 * XML do CT-e 4.00 (modelo 57, modal rodoviário) e dos eventos, no leiaute do MOC 4.00.
 * Montagem por string e sem espaços entre tags, como a assinatura exige.
 */

export const NS_CTE = 'http://www.portalfiscal.inf.br/cte';
export const VERSAO = '4.00';
export const HOMOLOGACAO_NOME = 'CTE EMITIDO EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

export const UF_CODIGO: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

/** Texto livre: sem caracteres de controle, espaços simples, no tamanho do campo. */
const txt = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const el = (nome: string, valor: unknown) => (valor === undefined || valor === null || valor === '' ? '' : `<${nome}>${esc(String(valor))}</${nome}>`);
const grupo = (nome: string, ...filhos: string[]) => `<${nome}>${filhos.join('')}</${nome}>`;
export const dec = (n: number, casas = 2) => (Math.round((n || 0) * 10 ** casas) / 10 ** casas).toFixed(casas);
const soDig = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Dígito verificador módulo 11 da chave de acesso (pesos 2 a 9 da direita para a esquerda). */
export function dvChave(base43: string) {
  let soma = 0, peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) { soma += Number(base43[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function montarChave(p: { uf: string; aamm: string; cnpj: string; modelo: '57' | '58'; serie: number; numero: number; tpEmis?: number; codigo: string }) {
  const base = `${UF_CODIGO[p.uf]}${p.aamm}${p.cnpj.padStart(14, '0')}${p.modelo}${String(p.serie).padStart(3, '0')}${String(p.numero).padStart(9, '0')}${p.tpEmis ?? 1}${p.codigo.padStart(8, '0')}`;
  if (base.length !== 43) throw new Error('Dados insuficientes para a chave de acesso.');
  return base + dvChave(base);
}

/** Data/hora com fuso de Brasília (AAAA-MM-DDThh:mm:ss-03:00). */
export function dataHora(d = new Date()) {
  return `${new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 19)}-03:00`;
}

export interface Endereco { logradouro: string; numero: string; complemento?: string | null; bairro: string; codMunicipio: string; municipio: string; cep?: string | null; uf: string }
export interface Parte { documento: string; ie?: string | null; nome: string; fone?: string | null; email?: string | null; endereco: Endereco }

export interface DadosCte {
  tpAmb: 1 | 2;
  chave: string; codigo: string; numero: number; serie: number; dhEmi: string; verProc: string;
  cfop: string; natOp: string;
  emitente: { cnpj: string; ie: string; nome: string; fantasia?: string | null; fone?: string | null; endereco: Endereco; crt: 1 | 2 | 3 | 4 };
  inicio: { ibge: string; municipio: string; uf: string };
  fim: { ibge: string; municipio: string; uf: string };
  /** 0 remetente, 3 destinatário, 4 outros (tomador abaixo) */
  toma: 0 | 3 | 4;
  indIEToma: 1 | 2 | 9;
  tomador?: Parte;
  remetente: Parte;
  destinatario: Parte;
  valorPrestacao: number;
  icms: { cst: '00' | '40' | '41' | '51' | '90' | 'SN'; aliquota: number };
  carga: { valor: number; produto: string; pesoKg: number };
  chavesNfe: string[];
  rntrc: string;
  observacao?: string | null;
  qrCodeUrl: string;
}

function documento(doc: string) {
  const d = soDig(doc);
  return d.length === 11 ? el('CPF', d) : el('CNPJ', d);
}
function ie(v?: string | null) {
  const x = String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return x ? el('IE', x === 'ISENTO' ? 'ISENTO' : x) : '';
}
function endereco(nome: string, e: Endereco, pais: boolean) {
  return grupo(nome, el('xLgr', txt(e.logradouro, 255)), el('nro', txt(e.numero || 'SN', 60)), el('xCpl', txt(e.complemento, 60)), el('xBairro', txt(e.bairro, 60)),
    el('cMun', e.codMunicipio), el('xMun', txt(e.municipio, 60)), el('CEP', soDig(e.cep).length === 8 ? soDig(e.cep) : ''), el('UF', e.uf), pais ? el('cPais', '1058') + el('xPais', 'BRASIL') : '');
}
const fone = (f?: string | null) => (soDig(f).length >= 6 ? el('fone', soDig(f).slice(0, 14)) : '');

function parte(nome: string, ender: string, p: Parte, tpAmb: 1 | 2) {
  const x = tpAmb === 2 ? HOMOLOGACAO_NOME : txt(p.nome, 60);
  return grupo(nome, documento(p.documento), ie(p.ie), el('xNome', x), fone(p.fone), endereco(ender, p.endereco, true), el('email', p.email ? txt(p.email, 60) : ''));
}

function icms(d: DadosCte) {
  const v = d.valorPrestacao, a = d.icms.aliquota;
  switch (d.icms.cst) {
    case '00': return grupo('ICMS00', el('CST', '00'), el('vBC', dec(v)), el('pICMS', dec(a)), el('vICMS', dec((v * a) / 100)));
    case '90': return grupo('ICMS90', el('CST', '90'), el('vBC', dec(v)), el('pICMS', dec(a)), el('vICMS', dec((v * a) / 100)));
    case 'SN': return grupo('ICMSSN', el('CST', '90'), el('indSN', '1'));
    default: return grupo('ICMS45', el('CST', d.icms.cst));
  }
}

/** infCte sem assinatura. */
export function montarCte(d: DadosCte): string {
  const e = d.emitente;
  const tomador = d.toma === 4 && d.tomador
    ? grupo('toma4', el('toma', '4'), documento(d.tomador.documento), ie(d.tomador.ie), el('xNome', d.tpAmb === 2 ? HOMOLOGACAO_NOME : txt(d.tomador.nome, 60)), fone(d.tomador.fone),
      endereco('enderToma', d.tomador.endereco, true), el('email', d.tomador.email ? txt(d.tomador.email, 60) : ''))
    : grupo('toma3', el('toma', String(d.toma)));
  const ide = grupo('ide',
    el('cUF', UF_CODIGO[e.endereco.uf]), el('cCT', d.codigo), el('CFOP', d.cfop), el('natOp', txt(d.natOp, 60)), el('mod', '57'), el('serie', d.serie), el('nCT', d.numero),
    el('dhEmi', d.dhEmi), el('tpImp', '1'), el('tpEmis', '1'), el('cDV', d.chave.slice(-1)), el('tpAmb', d.tpAmb), el('tpCTe', '0'), el('procEmi', '0'), el('verProc', txt(d.verProc, 20)),
    el('cMunEnv', e.endereco.codMunicipio), el('xMunEnv', txt(e.endereco.municipio, 60)), el('UFEnv', e.endereco.uf), el('modal', '01'), el('tpServ', '0'),
    el('cMunIni', d.inicio.ibge), el('xMunIni', txt(d.inicio.municipio, 60)), el('UFIni', d.inicio.uf), el('cMunFim', d.fim.ibge), el('xMunFim', txt(d.fim.municipio, 60)), el('UFFim', d.fim.uf),
    el('retira', '1'), el('indIEToma', d.indIEToma), tomador);
  const compl = d.observacao ? grupo('compl', el('xObs', txt(d.observacao, 2000))) : '';
  const emit = grupo('emit', el('CNPJ', soDig(e.cnpj)), ie(e.ie), el('xNome', txt(e.nome, 60)), el('xFant', e.fantasia ? txt(e.fantasia, 60) : ''),
    grupo('enderEmit', el('xLgr', txt(e.endereco.logradouro, 60)), el('nro', txt(e.endereco.numero || 'SN', 60)), el('xCpl', txt(e.endereco.complemento, 60)), el('xBairro', txt(e.endereco.bairro, 60)),
      el('cMun', e.endereco.codMunicipio), el('xMun', txt(e.endereco.municipio, 60)), el('CEP', soDig(e.endereco.cep).length === 8 ? soDig(e.endereco.cep) : ''), el('UF', e.endereco.uf), fone(e.fone)),
    el('CRT', e.crt));
  const vPrest = grupo('vPrest', el('vTPrest', dec(d.valorPrestacao)), el('vRec', dec(d.valorPrestacao)), grupo('Comp', el('xNome', 'FRETE VALOR'), el('vComp', dec(d.valorPrestacao))));
  const imp = grupo('imp', grupo('ICMS', icms(d)));
  const norm = grupo('infCTeNorm',
    grupo('infCarga', el('vCarga', dec(d.carga.valor)), el('proPred', txt(d.carga.produto || 'DIVERSOS', 60)),
      grupo('infQ', el('cUnid', '01'), el('tpMed', 'PESO BRUTO'), el('qCarga', dec(d.carga.pesoKg, 4)))),
    grupo('infDoc', ...d.chavesNfe.map((c) => grupo('infNFe', el('chave', c)))),
    `<infModal versaoModal="${VERSAO}">${grupo('rodo', el('RNTRC', soDig(d.rntrc).padStart(8, '0')))}</infModal>`);
  const inf = `<infCte versao="${VERSAO}" Id="CTe${d.chave}">${ide}${compl}${emit}${parte('rem', 'enderReme', d.remetente, d.tpAmb)}${parte('dest', 'enderDest', d.destinatario, d.tpAmb)}${vPrest}${imp}${norm}</infCte>`;
  const supl = `<infCTeSupl>${el('qrCodCTe', `${d.qrCodeUrl}?chCTe=${d.chave}&tpAmb=${d.tpAmb}`)}</infCTeSupl>`;
  return `<CTe xmlns="${NS_CTE}">${inf}${supl}</CTe>`;
}

/** Assinatura XMLDSig enveloped (C14N, RSA-SHA1) do elemento indicado, com a Signature como último filho da raiz. */
export function assinar(xml: string, elemento: 'infCte' | 'infEvento' | 'infMDFe', cert: CertificadoA1): string {
  const sig = new SignedXml({ privateKey: cert.chavePem, publicCert: cert.certPem, signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', canonicalizationAlgorithm: C14N });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data>`;
  sig.addReference({ xpath: `//*[local-name(.)='${elemento}']`, digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N] });
  // CT-e e MDF-e: a assinatura fica depois do grupo suplementar (QR Code), como último filho da raiz
  const raiz = elemento === 'infEvento' ? 'eventoCTe|eventoMDFe' : elemento === 'infCte' ? 'CTe' : 'MDFe';
  sig.computeSignature(xml, { location: { reference: `/*[${raiz.split('|').map((r) => `local-name(.)='${r}'`).join(' or ')}]`, action: 'append' } });
  return sig.getSignedXml();
}

/** Evento do CT-e (cancelamento etc.), sem assinatura. */
export function montarEventoCte(p: { tpAmb: 1 | 2; cnpj: string; chave: string; tpEvento: string; nSeq: number; detalhe: string; dhEvento?: string }) {
  const seq = String(p.nSeq).padStart(3, '0');
  return `<eventoCTe xmlns="${NS_CTE}" versao="${VERSAO}"><infEvento Id="ID${p.tpEvento}${p.chave}${seq}">${el('cOrgao', p.chave.slice(0, 2))}${el('tpAmb', p.tpAmb)}${el('CNPJ', soDig(p.cnpj))}`
    + `${el('chCTe', p.chave)}${el('dhEvento', p.dhEvento ?? dataHora(new Date(Date.now() - 60_000)))}${el('tpEvento', p.tpEvento)}${el('nSeqEvento', p.nSeq)}`
    + `<detEvento versaoEvento="${VERSAO}">${p.detalhe}</detEvento></infEvento></eventoCTe>`;
}
export const detalheCancelamento = (nProt: string, justificativa: string) =>
  `<evCancCTe>${el('descEvento', 'Cancelamento')}${el('nProt', nProt)}${el('xJust', txt(justificativa, 255))}</evCancCTe>`;

// ------------------------------------------------------------- leitura de retornos

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });
export function achar(o: any, nome: string): any {
  if (!o || typeof o !== 'object') return undefined;
  if (nome in o) return o[nome];
  for (const v of Object.values(o)) { const r = achar(v, nome); if (r !== undefined) return r; }
  return undefined;
}
export const lerXml = (xml: string) => parser.parse(xml);

export interface Retorno { cStat: string; xMotivo: string; nProt?: string; dhRecbto?: string; protocoloXml?: string }

/** Lê o retorno da autorização (retCTe / retMDFe) ou do evento (retEventoCTe / retEventoMDFe). */
export function lerRetorno(xml: string, raiz: string): Retorno {
  const o = lerXml(xml);
  const r = achar(o, raiz);
  if (!r) {
    const motivo = achar(o, 'xMotivo') ?? achar(o, 'Text') ?? achar(o, 'faultstring');
    throw new Error(`Resposta inesperada da SEFAZ${motivo ? `: ${typeof motivo === 'object' ? motivo['#text'] : motivo}` : '.'}`);
  }
  const inf = r.protCTe?.infProt ?? r.protMDFe?.infProt ?? r.infEvento ?? r;
  const protTag = xml.match(/<(?:\w+:)?(protCTe|protMDFe)[\s\S]*?<\/(?:\w+:)?\1>/)?.[0];
  return {
    cStat: String(inf.cStat ?? r.cStat ?? ''), xMotivo: String(inf.xMotivo ?? r.xMotivo ?? ''),
    nProt: inf.nProt ? String(inf.nProt) : undefined, dhRecbto: inf.dhRecbto ? String(inf.dhRecbto) : inf.dhRegEvento ? String(inf.dhRegEvento) : undefined,
    protocoloXml: protTag?.replace(/<(\/?)\w+:/g, '<$1'),
  };
}

/** Lê do XML da NF-e os dados de remetente (emitente da nota) e destinatário, com endereço completo. */
export function partesDaNfe(xml: string): { remetente: Parte; destinatario: Parte } {
  const o = lerXml(xml);
  const inf = achar(o, 'infNFe');
  const conv = (p: any, end: any): Parte => ({
    documento: String(p?.CNPJ ?? p?.CPF ?? ''), ie: p?.IE ? String(p.IE) : null, nome: String(p?.xNome ?? ''), fone: end?.fone ? String(end.fone) : null, email: p?.email ? String(p.email) : null,
    endereco: { logradouro: String(end?.xLgr ?? ''), numero: String(end?.nro ?? 'SN'), complemento: end?.xCpl ? String(end.xCpl) : null, bairro: String(end?.xBairro ?? ''),
      codMunicipio: String(end?.cMun ?? ''), municipio: String(end?.xMun ?? ''), cep: end?.CEP ? String(end.CEP) : null, uf: String(end?.UF ?? '') },
  });
  return { remetente: conv(inf?.emit, inf?.emit?.enderEmit), destinatario: conv(inf?.dest, inf?.dest?.enderDest) };
}
