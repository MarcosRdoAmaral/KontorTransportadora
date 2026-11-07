import https from 'node:https';
import zlib from 'node:zlib';
import type { CertificadoA1 } from '../nfse/certificado.js';
import { autoridadesSefaz, verificarServidorSefaz } from '../nfe/confianca.js';
import { ErroSefaz } from '../nfe/sefaz-an.js';
import WS from '../ws-cte.json' with { type: 'json' };
import { NS_CTE, VERSAO, UF_CODIGO } from './xml-cte.js';

/**
 * Web services do CT-e 4.00 (MOC 4.00, sem SOAP Header desde a 4.00a):
 *  - CTeRecepcaoSincV4: autorização síncrona, mensagem compactada em GZip + Base64;
 *  - CTeRecepcaoEventoV4: eventos (cancelamento), XML sem compactação;
 *  - CTeStatusServicoV4 e CTeConsultaV4.
 */

/** Autorizador do CT-e por UF do emitente (SVRS para as UF sem ambiente próprio; SVSP para AP, PE e RR). */
const AUTORIZADOR: Record<string, string> = { MG: 'MG', MS: 'MS', MT: 'MT', PR: 'PR', RS: 'RS', SP: 'SP', AP: 'SVSP', PE: 'SVSP', RR: 'SVSP' };
export const autorizadorCte = (uf: string) => AUTORIZADOR[uf] ?? 'SVRS';

type Servico = 'recepcao' | 'evento' | 'consulta' | 'status' | 'qrcode';
export function urlCte(uf: string, tpAmb: 1 | 2, servico: Servico): string {
  const teste = process.env.SEFAZ_CTE_URL_TESTE;
  if (teste && servico !== 'qrcode') return `${teste}/${servico}`;
  const u = (WS as any)[autorizadorCte(uf)]?.[String(tpAmb)]?.[servico];
  if (!u) throw new ErroSefaz(`Serviço de CT-e não encontrado para ${uf}.`, 'SEFAZ');
  return u;
}

const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
const WSDL = 'http://www.portalfiscal.inf.br/cte/wsdl';
const OPERACAO: Record<Exclude<Servico, 'qrcode'>, [string, string]> = {
  recepcao: ['CTeRecepcaoSincV4', 'cteRecepcao'],
  evento: ['CTeRecepcaoEventoV4', 'cteRecepcaoEvento'],
  consulta: ['CTeConsultaV4', 'cteConsultaCT'],
  status: ['CTeStatusServicoV4', 'cteStatusServicoCT'],
};

const ERROS_CADEIA = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE']);

export function corpoSoap(servico: Exclude<Servico, 'qrcode'>, xml: string) {
  const [op] = OPERACAO[servico];
  const dados = servico === 'recepcao' ? zlib.gzipSync(Buffer.from(xml.replace(/^<\?xml[^>]*\?>/, ''), 'utf8')).toString('base64') : xml.replace(/^<\?xml[^>]*\?>/, '');
  return `<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="${NS_SOAP12}"><Body><cteDadosMsg xmlns="${WSDL}/${op}">${dados}</cteDadosMsg></Body></Envelope>`;
}

export class SefazCte {
  private agent: https.Agent;
  constructor(cert: CertificadoA1, private uf: string, private tpAmb: 1 | 2) {
    const teste = process.env.SEFAZ_CTE_URL_TESTE;
    const verificar = !teste;
    this.agent = new https.Agent({ key: cert.chavePem, cert: cert.cadeiaPem, keepAlive: true, ca: verificar ? autoridadesSefaz() : undefined, rejectUnauthorized: verificar && verificarServidorSefaz() });
  }
  fechar() { this.agent.destroy(); }

  autorizar(cteAssinado: string) { return this.enviar('recepcao', cteAssinado); }
  evento(eventoAssinado: string) { return this.enviar('evento', eventoAssinado); }
  status() {
    return this.enviar('status', `<consStatServCTe xmlns="${NS_CTE}" versao="${VERSAO}"><tpAmb>${this.tpAmb}</tpAmb><cUF>${UF_CODIGO[this.uf]}</cUF><xServ>STATUS</xServ></consStatServCTe>`);
  }
  consulta(chave: string) {
    return this.enviar('consulta', `<consSitCTe xmlns="${NS_CTE}" versao="${VERSAO}"><tpAmb>${this.tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chCTe>${chave}</chCTe></consSitCTe>`);
  }

  private enviar(servico: Exclude<Servico, 'qrcode'>, xml: string): Promise<string> {
    const url = urlCte(this.uf, this.tpAmb, servico);
    const [op, metodo] = OPERACAO[servico];
    return postSoap(url, `${WSDL}/${op}/${metodo}`, corpoSoap(servico, xml), this.agent);
  }
}

/** POST SOAP 1.2 com mTLS, traduzindo os erros de rede/TLS para mensagens claras. */
export function postSoap(url: string, acao: string, xml: string, agent: https.Agent): Promise<string> {
  const dados = Buffer.from(xml, 'utf8');
  return new Promise((resolve, reject) => {
    const r = https.request(url, {
      method: 'POST', agent, timeout: 60_000,
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
      if (e.code && ERROS_CADEIA.has(e.code)) reject(new ErroSefaz('O computador não reconhece o certificado do servidor da SEFAZ (cadeia ICP-Brasil).', 'CADEIA'));
      else if (e.code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' || /alert (bad|unknown) certificate|certificate required/i.test(e.message)) reject(new ErroSefaz('A SEFAZ recusou o certificado A1 da empresa na conexão. Confira se é e-CNPJ válido e não foi revogado.', 'SEFAZ'));
      else reject(new ErroSefaz(`Não foi possível falar com a SEFAZ (${e.code ?? e.message}). Confira a internet e tente de novo.`, 'REDE'));
    });
    r.end(dados);
  });
}
