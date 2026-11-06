import https from 'node:https';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { SignedXml } from 'xml-crypto';
import type { CertificadoA1 } from '../nfse/certificado.js';
import { autoridadesSefaz, verificarServidorSefaz } from './confianca.js';

/**
 * Cliente dos web services do Ambiente Nacional da NF-e usados para receber as notas de entrada:
 *  - NFeDistribuicaoDFe (NT 2014.002): lista resumos, XMLs completos e eventos das NF-e
 *    em que o CNPJ é interessado (destinatário, transportador, autorizado);
 *  - NFeRecepcaoEvento4 (cOrgao 91): manifestação do destinatário — aqui só a Ciência da Operação
 *    (210210), que libera o download do XML completo.
 */

export const SEFAZ_AN = {
  distribuicao: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  evento: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
};
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';
const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
const WSDL_DIST = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe';
const WSDL_EVENTO = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

export const TP_CIENCIA = '210210';
export const EVENTOS_CANCELAMENTO = ['110111', '110112'];

/** Erros de TLS que indicam que a cadeia do servidor não é reconhecida (falta a ICP-Brasil). */
const ERROS_CADEIA = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE',
]);

export class ErroSefaz extends Error {
  constructor(msg: string, public tipo: 'CADEIA' | 'REDE' | 'SEFAZ', public cStat?: string) {
    super(msg);
  }
}

export interface DocDistribuido { nsu: string; schema: string; tipo: string; xml: string }
export interface RetornoDistribuicao { cStat: string; xMotivo: string; ultNSU: string; maxNSU: string; docs: DocDistribuido[] }
export interface RetornoEvento { cStat: string; xMotivo: string; porChave: Map<string, { cStat: string; xMotivo: string }> }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nsu15 = (n: string | number) => String(n).replace(/\D/g, '').padStart(15, '0').slice(-15);

function docInteressado(documento: string) {
  const d = documento.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (d.length === 11) return `<CPF>${d}</CPF>`;
  if (d.length === 14) return `<CNPJ>${d}</CNPJ>`;
  throw new Error('CNPJ/CPF da empresa inválido para consultar a SEFAZ.');
}

/** Pedido de distribuição: pelo último NSU recebido ou por uma chave de acesso específica. */
export function montarDistribuicao(tpAmb: 1 | 2, cUF: string, documento: string, alvo: { ultNSU: string } | { chave: string }): string {
  const consulta = 'chave' in alvo
    ? `<consChNFe><chNFe>${alvo.chave.replace(/\D/g, '')}</chNFe></consChNFe>`
    : `<distNSU><ultNSU>${nsu15(alvo.ultNSU)}</ultNSU></distNSU>`;
  return `<distDFeInt xmlns="${NS_NFE}" versao="1.01"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cUF}</cUFAutor>${docInteressado(documento)}${consulta}</distDFeInt>`;
}

/** Data/hora local com fuso (AAAA-MM-DDThh:mm:ss-03:00), como pede o leiaute de eventos. */
export function dataHoraComFuso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
}

function assinarEvento(eventoXml: string, cert: CertificadoA1): string {
  const sig = new SignedXml({
    privateKey: cert.chavePem,
    publicCert: cert.certPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: C14N,
  });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data>`;
  sig.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
  });
  sig.computeSignature(eventoXml, { location: { reference: "//*[local-name(.)='infEvento']", action: 'after' } });
  return sig.getSignedXml();
}

/** Lote (até 20) de eventos de manifestação do destinatário, cada um assinado com o A1 da empresa. */
export function montarEnvEvento(cert: CertificadoA1, tpAmb: 1 | 2, documento: string, chaves: string[], agora = new Date(),
  tpEvento = TP_CIENCIA, descricao = 'Ciencia da Operacao'): string {
  if (!chaves.length || chaves.length > 20) throw new Error('Envie de 1 a 20 eventos por lote.');
  // um minuto de folga para relógios adiantados (a SEFAZ recusa evento "no futuro")
  const dh = dataHoraComFuso(new Date(agora.getTime() - 60_000));
  const eventos = chaves.map((ch) => {
    const chave = ch.replace(/\D/g, '');
    const id = `ID${tpEvento}${chave}01`;
    const evento = `<evento xmlns="${NS_NFE}" versao="1.00"><infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${tpAmb}</tpAmb>${docInteressado(documento)}`
      + `<chNFe>${chave}</chNFe><dhEvento>${dh}</dhEvento><tpEvento>${tpEvento}</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>`
      + `<detEvento versao="1.00"><descEvento>${esc(descricao)}</descEvento></detEvento></infEvento></evento>`;
    return assinarEvento(evento, cert);
  });
  const idLote = String(agora.getTime()).slice(-15);
  return `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>${idLote}</idLote>${eventos.join('')}</envEvento>`;
}

/**
 * Envelope SOAP 1.2 com namespace padrão (sem prefixo): nenhum namespace extra fica em escopo
 * sobre o XML assinado, e a assinatura confere do mesmo jeito qualquer que seja a forma como
 * o servidor extrai o conteúdo do nfeDadosMsg.
 */
export function envelope(corpo: string) {
  return `<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="${NS_SOAP12}"><Body>${corpo}</Body></Envelope>`;
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true,
  isArray: (nome) => ['docZip', 'retEvento'].includes(nome),
});

function achar(o: any, nome: string): any {
  if (!o || typeof o !== 'object') return undefined;
  if (nome in o) return o[nome];
  for (const v of Object.values(o)) {
    const r = achar(v, nome);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function lerRetornoDistribuicao(xml: string): RetornoDistribuicao {
  const ret = achar(parser.parse(xml), 'retDistDFeInt');
  if (!ret) throw new ErroSefaz('Resposta da SEFAZ sem o retorno da distribuição (retDistDFeInt).', 'SEFAZ');
  const docs: DocDistribuido[] = [];
  for (const d of ret.loteDistDFeInt?.docZip ?? []) {
    const schema = String(d['@schema'] ?? '');
    const b64 = typeof d === 'string' ? d : String(d['#text'] ?? '');
    try {
      docs.push({ nsu: String(d['@NSU'] ?? ''), schema, tipo: schema.split('_')[0], xml: zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8') });
    } catch { /* documento corrompido: ignora */ }
  }
  return { cStat: String(ret.cStat ?? ''), xMotivo: String(ret.xMotivo ?? ''), ultNSU: String(ret.ultNSU ?? ''), maxNSU: String(ret.maxNSU ?? ''), docs };
}

export function lerRetornoEvento(xml: string): RetornoEvento {
  const ret = achar(parser.parse(xml), 'retEnvEvento');
  if (!ret) throw new ErroSefaz('Resposta da SEFAZ sem o retorno do evento (retEnvEvento).', 'SEFAZ');
  const porChave = new Map<string, { cStat: string; xMotivo: string }>();
  for (const r of ret.retEvento ?? []) {
    const i = r.infEvento ?? {};
    porChave.set(String(i.chNFe ?? ''), { cStat: String(i.cStat ?? ''), xMotivo: String(i.xMotivo ?? '') });
  }
  return { cStat: String(ret.cStat ?? ''), xMotivo: String(ret.xMotivo ?? ''), porChave };
}

/** Lê os campos de um documento distribuído (resumo ou evento) sem depender do schema exato. */
export function lerDocumento(xml: string): Record<string, string> {
  const o = parser.parse(xml);
  const campos: Record<string, string> = {};
  const varrer = (x: any) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (v !== null && typeof v === 'object') varrer(v);
      else if (!(k in campos)) campos[k] = String(v);
    }
  };
  varrer(o);
  return campos;
}

export class SefazAN {
  private agent: https.Agent;
  private urls: typeof SEFAZ_AN;

  constructor(cert: CertificadoA1) {
    // só para testes automatizados com servidor falso; SEFAZ_AN_VERIFICAR_TESTE=1 mantém a verificação do servidor ligada
    const teste = process.env.SEFAZ_AN_URL_TESTE;
    const verificar = !teste || process.env.SEFAZ_AN_VERIFICAR_TESTE === '1';
    this.urls = teste ? { distribuicao: `${teste}/distribuicao`, evento: `${teste}/evento` } : SEFAZ_AN;
    this.agent = new https.Agent({
      key: cert.chavePem, cert: cert.cadeiaPem, keepAlive: true,
      ca: verificar ? autoridadesSefaz() : undefined,
      rejectUnauthorized: verificar && verificarServidorSefaz(),
    });
  }

  fechar() { this.agent.destroy(); }

  async distribuicao(tpAmb: 1 | 2, cUF: string, documento: string, alvo: { ultNSU: string } | { chave: string }): Promise<RetornoDistribuicao> {
    const corpo = `<nfeDistDFeInteresse xmlns="${WSDL_DIST}"><nfeDadosMsg>${montarDistribuicao(tpAmb, cUF, documento, alvo)}</nfeDadosMsg></nfeDistDFeInteresse>`;
    return lerRetornoDistribuicao(await this.post(this.urls.distribuicao, `${WSDL_DIST}/nfeDistDFeInteresse`, envelope(corpo)));
  }

  async ciencia(cert: CertificadoA1, tpAmb: 1 | 2, documento: string, chaves: string[]): Promise<RetornoEvento> {
    const corpo = `<nfeDadosMsg xmlns="${WSDL_EVENTO}">${montarEnvEvento(cert, tpAmb, documento, chaves)}</nfeDadosMsg>`;
    return lerRetornoEvento(await this.post(this.urls.evento, `${WSDL_EVENTO}/nfeRecepcaoEvento`, envelope(corpo)));
  }

  private post(url: string, acao: string, xml: string): Promise<string> {
    const dados = Buffer.from(xml, 'utf8');
    return new Promise((resolve, reject) => {
      const r = https.request(url, {
        method: 'POST', agent: this.agent, timeout: 60_000,
        headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${acao}"`, 'Content-Length': dados.length },
      }, (res) => {
        const partes: Buffer[] = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const corpo = Buffer.concat(partes).toString('utf8');
          if (res.statusCode === 200 && !/<(\w+:)?Fault[\s>]/.test(corpo)) return resolve(corpo);
          const motivo = corpo.match(/<(?:\w+:)?(?:Text|faultstring|xMotivo)[^>]*>([^<]+)</)?.[1]?.trim();
          reject(new ErroSefaz(`A SEFAZ recusou a requisição (HTTP ${res.statusCode})${motivo ? `: ${motivo}` : '.'}`, 'SEFAZ'));
        });
      });
      r.on('timeout', () => r.destroy(Object.assign(new Error('tempo esgotado'), { code: 'ETIMEDOUT' })));
      r.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code && ERROS_CADEIA.has(e.code)) {
          reject(new ErroSefaz('O computador não reconhece o certificado do servidor da SEFAZ (cadeia ICP-Brasil).', 'CADEIA'));
        } else if (e.code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' || /alert (bad|unknown) certificate|certificate required/i.test(e.message)) {
          reject(new ErroSefaz('A SEFAZ recusou o certificado A1 da empresa na conexão. Confira se o certificado é e-CNPJ válido e não foi revogado.', 'SEFAZ'));
        } else {
          reject(new ErroSefaz(`Não foi possível falar com a SEFAZ (${e.code ?? e.message}). Confira a internet e tente de novo.`, 'REDE'));
        }
      });
      r.end(dados);
    });
  }
}
