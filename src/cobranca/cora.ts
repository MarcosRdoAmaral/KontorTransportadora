import http from 'node:http';
import https from 'node:https';
import { ErroNegocio } from '../servicos/emissao.js';

/**
 * Cliente da API da Cora (integração direta): mTLS com certificado e chave da empresa + token OAuth2 (client_credentials).
 * Valores monetários trafegam em centavos. Em testes, CORA_URL_TESTE troca o endereço da API.
 */
export interface CoraCredenciais { clientId: string; certPem: string; chavePem: string; ambiente: 'teste' | 'producao' }

export const centavos = (v: number) => Math.round((v + Number.EPSILON) * 100);
export const reais = (c: number) => Math.round(c) / 100;
export const VALOR_MINIMO = 5;

const BASE = { teste: 'https://matls-clients.api.stage.cora.com.br', producao: 'https://matls-clients.api.cora.com.br' };
const tokens = new Map<string, { token: string; ate: number }>();

/** Erro de comunicação ou de servidor (vale tentar de novo depois). Erros de dados viram ErroNegocio. */
export class ErroRedeCora extends Error {}

export interface FaturaCora {
  id: string; status: string; code?: string; total_amount?: number; total_paid?: number; occurrence_date?: string;
  payment_options?: { bank_slip?: { barcode?: string; digitable?: string; url?: string; our_number?: string } };
  pix?: { emv?: string };
}
export interface LancamentoCora { id: string; type: string; amount: number; createdAt: string; transaction?: { id?: string; type?: string; description?: string; counterParty?: { name?: string; identity?: string } } }

export class CoraApi {
  private agent: https.Agent | null = null;
  private base: string;
  private chave: string;
  constructor(private cred: CoraCredenciais) {
    const teste = process.env.CORA_URL_TESTE;
    this.base = (teste ?? BASE[cred.ambiente]).replace(/\/$/, '');
    this.chave = `${this.base}|${cred.clientId}`;
    if (this.base.startsWith('https:')) this.agent = new https.Agent({ cert: cred.certPem, key: cred.chavePem, keepAlive: true });
  }

  fechar() { this.agent?.destroy(); }

  private enviar(metodo: string, caminho: string, opc: { cabecalhos?: Record<string, string>; corpo?: string } = {}): Promise<{ status: number; texto: string }> {
    const url = new URL(this.base + caminho);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const r = mod.request(url, { method: metodo, agent: this.agent ?? undefined, headers: { accept: 'application/json', ...opc.cabecalhos }, timeout: 30_000 }, (res) => {
        const partes: Buffer[] = [];
        res.on('data', (b) => partes.push(b));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, texto: Buffer.concat(partes).toString('utf8') }));
      });
      r.on('timeout', () => r.destroy(new Error('tempo esgotado')));
      r.on('error', (e) => reject(new ErroRedeCora(`Sem comunicação com a Cora: ${e.message}`)));
      if (opc.corpo) r.write(opc.corpo);
      r.end();
    });
  }

  async token(forcar = false): Promise<string> {
    const c = tokens.get(this.chave);
    if (!forcar && c && c.ate > Date.now() + 60_000) return c.token;
    const r = await this.enviar('POST', '/token', {
      cabecalhos: { 'content-type': 'application/x-www-form-urlencoded' },
      corpo: `grant_type=client_credentials&client_id=${encodeURIComponent(this.cred.clientId)}`,
    });
    let j: any = {};
    try { j = JSON.parse(r.texto); } catch { /* resposta fora do padrão */ }
    if (r.status >= 500) throw new ErroRedeCora(`A Cora está indisponível (${r.status}).`);
    if (r.status !== 200 || !j.access_token) {
      throw new ErroNegocio(`A Cora recusou as credenciais (${r.status}). Confira o Client ID, o certificado, a chave e o ambiente (${this.cred.ambiente === 'teste' ? 'teste' : 'produção'}).`);
    }
    tokens.set(this.chave, { token: j.access_token, ate: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
    return j.access_token;
  }

  private async chamar(metodo: string, caminho: string, corpo?: unknown, idem?: string, tentativa = 0): Promise<{ status: number; json: any }> {
    const token = await this.token(tentativa > 0);
    const cab: Record<string, string> = { authorization: `Bearer ${token}` };
    if (corpo !== undefined) cab['content-type'] = 'application/json';
    if (idem) cab['idempotency-key'] = idem;
    const r = await this.enviar(metodo, caminho, { cabecalhos: cab, corpo: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    if (r.status === 401 && tentativa === 0) { tokens.delete(this.chave); return this.chamar(metodo, caminho, corpo, idem, 1); }
    let json: any = null;
    if (r.texto) { try { json = JSON.parse(r.texto); } catch { json = { texto: r.texto }; } }
    if (r.status >= 500) throw new ErroRedeCora(`A Cora está indisponível (${r.status}). Vamos tentar de novo.`);
    return { status: r.status, json };
  }

  private erro(status: number, j: any): ErroNegocio {
    const lista = Array.isArray(j?.errors) ? j.errors : Array.isArray(j) ? j : [];
    const msg = lista.map((e: any) => e?.message ?? e?.code).filter(Boolean).join('; ') || j?.message || j?.error_description || j?.texto || `erro ${status}`;
    return new ErroNegocio(`Cora: ${msg}`);
  }

  async emitir(corpo: unknown, idem: string): Promise<FaturaCora> {
    const r = await this.chamar('POST', '/v2/invoices/', corpo, idem);
    if (r.status >= 200 && r.status < 300 && r.json?.id) return r.json;
    throw this.erro(r.status, r.json);
  }

  async consultar(id: string): Promise<FaturaCora> {
    const r = await this.chamar('GET', `/v2/invoices/${encodeURIComponent(id)}`);
    if (r.status === 200) return r.json;
    throw this.erro(r.status, r.json);
  }

  /** Ids dos boletos pagos no período (a Cora filtra pela data do pagamento quando state=PAID). */
  async listarPagos(inicio: string, fim: string): Promise<string[]> {
    const ids: string[] = [];
    for (let pagina = 1; pagina <= 50; pagina++) {
      const r = await this.chamar('GET', `/v2/invoices/?state=PAID&start=${inicio}&end=${fim}&page=${pagina}&perPage=200`);
      if (r.status !== 200) throw this.erro(r.status, r.json);
      const itens: any[] = r.json?.items ?? [];
      ids.push(...itens.map((i) => String(i.id)));
      if (itens.length < 200) break;
    }
    return ids;
  }

  /** Cancela um boleto em aberto. Devolve 'pago' quando a Cora diz que ele já foi pago (REC-0006). */
  async cancelar(id: string): Promise<'cancelado' | 'pago'> {
    const r = await this.chamar('DELETE', `/v2/invoices/${encodeURIComponent(id)}`);
    if (r.status >= 200 && r.status < 300) return 'cancelado';
    if (JSON.stringify(r.json ?? '').includes('REC-0006')) return 'pago';
    throw this.erro(r.status, r.json);
  }

  async extrato(inicio: string, fim: string): Promise<{ saldoInicial: number | null; saldoFinal: number | null; lancamentos: LancamentoCora[] }> {
    const lancamentos: LancamentoCora[] = [];
    let saldoInicial: number | null = null, saldoFinal: number | null = null;
    for (let pagina = 1; pagina <= 100; pagina++) {
      const r = await this.chamar('GET', `/bank-statement/statement?start=${inicio}&end=${fim}&page=${pagina}&perPage=200`);
      if (r.status !== 200) throw this.erro(r.status, r.json);
      if (pagina === 1) saldoInicial = r.json?.start?.balance ?? null;
      saldoFinal = r.json?.end?.balance ?? saldoFinal;
      const itens: LancamentoCora[] = r.json?.entries ?? [];
      lancamentos.push(...itens);
      if (itens.length < 200) break;
    }
    return { saldoInicial: saldoInicial == null ? null : reais(saldoInicial), saldoFinal: saldoFinal == null ? null : reais(saldoFinal), lancamentos };
  }
}
