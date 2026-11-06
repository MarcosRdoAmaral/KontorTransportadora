import https from 'node:https';
import zlib from 'node:zlib';
import { SEFIN_URL } from '../config.js';
import type { CertificadoA1 } from './certificado.js';

export interface ErroSefin {
  codigo: string;
  descricao: string;
  complemento?: string;
}

export interface RespostaSefin {
  status: number;
  corpo: any;
  bruto: string;
  duracaoMs: number;
  url: string;
  metodo: string;
}

export const gzipB64 = (xml: string) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
export const ungzipB64 = (b64: string) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

/** A API devolve erros em formatos variados (erro/erros, Codigo/codigo). Normaliza tudo. */
export function extrairErros(corpo: any): ErroSefin[] {
  if (!corpo || typeof corpo !== 'object') return [];
  const lista = ([] as any[]).concat(corpo.erros ?? corpo.Erros ?? corpo.erro ?? corpo.Erro ?? []);
  return lista
    .filter(Boolean)
    .map((e: any) => ({
      codigo: String(e.Codigo ?? e.codigo ?? e.code ?? ''),
      descricao: String(e.Descricao ?? e.descricao ?? e.mensagem ?? e.message ?? JSON.stringify(e)),
      complemento: e.Complemento ?? e.complemento ?? undefined,
    }));
}

/**
 * Cliente HTTP da Sefin Nacional com autenticação mútua TLS (certificado A1 do contribuinte).
 */
export class SefinClient {
  private agent: https.Agent;
  private base: string;

  constructor(cert: CertificadoA1, ambiente: 1 | 2, private log?: (r: RespostaSefin) => void) {
    const alvo = process.env.SEFIN_URL_TESTE; // apenas para testes automatizados com servidor falso
    this.base = alvo ?? SEFIN_URL[ambiente];
    this.agent = new https.Agent({ key: cert.chavePem, cert: cert.cadeiaPem, keepAlive: true, rejectUnauthorized: !alvo });
  }

  private req(metodo: string, caminho: string, corpo?: object, timeoutMs = 60_000): Promise<RespostaSefin> {
    const url = this.base + caminho;
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : undefined;
    const inicio = Date.now();
    return new Promise((resolve, reject) => {
      const r = https.request(
        url,
        {
          method: metodo,
          agent: this.agent,
          headers: {
            Accept: 'application/json',
            ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const partes: Buffer[] = [];
          res.on('data', (c) => partes.push(c));
          res.on('end', () => {
            const bruto = Buffer.concat(partes).toString('utf8');
            let json: any = null;
            try {
              json = bruto ? JSON.parse(bruto) : null;
            } catch {
              json = null;
            }
            const resposta = { status: res.statusCode ?? 0, corpo: json, bruto, duracaoMs: Date.now() - inicio, url, metodo };
            this.log?.(resposta);
            resolve(resposta);
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('Tempo esgotado aguardando a Sefin Nacional.')));
      r.on('error', reject);
      if (dados) r.write(dados);
      r.end();
    });
  }

  /** Envia a DPS assinada. 201 = NFS-e gerada (chaveAcesso + nfseXmlGZipB64). */
  emitir(xmlDpsAssinado: string) {
    return this.req('POST', '/nfse', { dpsXmlGZipB64: gzipB64(xmlDpsAssinado) });
  }

  consultarNfse(chave: string) {
    return this.req('GET', `/nfse/${chave}`);
  }

  /** Recupera a chave de acesso a partir do Id da DPS (útil após timeout/queda de conexão). */
  consultarDps(idDps: string) {
    return this.req('GET', `/dps/${idDps}`);
  }

  registrarEvento(chave: string, xmlPedidoAssinado: string) {
    return this.req('POST', `/nfse/${chave}/eventos`, { pedidoRegistroEventoXmlGZipB64: gzipB64(xmlPedidoAssinado) });
  }

  consultarEventos(chave: string) {
    return this.req('GET', `/nfse/${chave}/eventos`);
  }
}
