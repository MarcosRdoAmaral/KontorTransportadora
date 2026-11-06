import crypto from 'node:crypto';
import tls from 'node:tls';
import forge from 'node-forge';
import { unzipSync } from 'fflate';
import { db } from '../db.js';
import { CADEIA_ICP_EMBUTIDA } from './icp-brasil-embutida.js';

/**
 * Confiança no servidor da SEFAZ (Ambiente Nacional da NF-e).
 *
 * Os web services da NF-e usam certificados da cadeia ICP-Brasil, que não está na lista de
 * autoridades do Node/Electron. Para a conexão com a SEFAZ (e só para ela) o sistema confia em:
 *  1. a cadeia ICP-Brasil embutida no sistema (raízes v5/v10/v11/v12 e as ACs SSL dos servidores de DF-e);
 *  2. autoridades padrão do Node e do sistema operacional (repositório do Windows);
 *  3. certificados adicionais guardados no banco — baixados do repositório oficial do ITI (só os que
 *     encadeiam até uma raiz embutida) ou enviados pelo administrador (.zip/.crt/.cer/.pem/.p7b).
 * Como último recurso o administrador pode desligar a verificação do servidor (não recomendado).
 */

const P_CADEIA = 'sefaz_cadeia_icp';
const P_VERIFICAR = 'sefaz_verificar_servidor';

/**
 * Repositório oficial do ITI. O site é servido por http:// (o https:// usa certificado que o próprio Node não
 * reconhece); a segurança vem da conferência da cadeia: só entram certificados assinados por uma raiz embutida.
 */
export const URL_ACCOMPACTADO = 'http://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip';
export const URL_REPOSITORIO_ITI = 'https://www.gov.br/iti/pt-br/assuntos/repositorio/repositorio-ac-raiz';

export const PEMS_EMBUTIDOS = CADEIA_ICP_EMBUTIDA.map((c) => c.pem);
const RAIZES_EMBUTIDAS = CADEIA_ICP_EMBUTIDA.filter((c) => c.tipo === 'raiz').map((c) => c.pem);

export function parametro(nome: string): string | null {
  const r = db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(nome) as { valor: string } | undefined;
  return r?.valor ?? null;
}

export function definirParametro(nome: string, valor: string | null) {
  if (valor == null) db.prepare('DELETE FROM parametros WHERE nome = ?').run(nome);
  else db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(nome, valor);
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Extrai os certificados de autoridade (AC) de um arquivo: PEM (um ou vários), DER (.cer/.crt),
 * PKCS#7 (.p7b, PEM ou DER) ou ZIP contendo esses arquivos. Certificados que não são de AC são ignorados.
 */
export function extrairCertificadosAc(dados: Buffer, profundidade = 0): string[] {
  const saida = new Map<string, string>();
  const tentar = (der: Buffer | string) => {
    try {
      const x = new crypto.X509Certificate(der);
      if (x.ca) saida.set(x.fingerprint256, x.toString());
    } catch { /* não é certificado */ }
  };
  const ehZip = dados.length > 4 && dados.readUInt32LE(0) === 0x04034b50;
  if (ehZip) {
    if (profundidade > 2) return [];
    let arquivos: Record<string, Uint8Array> = {};
    try { arquivos = unzipSync(new Uint8Array(dados)); } catch { return []; }
    for (const [nome, conteudo] of Object.entries(arquivos)) {
      if (nome.endsWith('/') || !conteudo.length) continue;
      for (const pem of extrairCertificadosAc(Buffer.from(conteudo), profundidade + 1)) tentar(pem);
    }
    return [...saida.values()];
  }
  const texto = dados.toString('latin1');
  const pems = texto.match(PEM_RE);
  if (pems) pems.forEach(tentar);
  if (/-----BEGIN PKCS7-----/.test(texto)) {
    for (const der of certificadosDoPkcs7(forge.pem.decode(texto).find((b) => b.type === 'PKCS7')?.body)) tentar(der);
  }
  if (!pems && !/-----BEGIN/.test(texto)) {
    const antes = saida.size;
    tentar(dados);
    if (saida.size === antes) for (const der of certificadosDoPkcs7(dados.toString('binary'))) tentar(der);
  }
  return [...saida.values()];
}

/** Lê os certificados de um PKCS#7 (SignedData) direto da estrutura ASN.1, aceitando qualquer tipo de chave. */
function certificadosDoPkcs7(binario: string | undefined): Buffer[] {
  if (!binario) return [];
  try {
    const raiz = forge.asn1.fromDer(binario);
    // ContentInfo ::= SEQUENCE { contentType, [0] EXPLICIT SignedData }
    const signedData = ((raiz.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
    const campos = signedData.value as forge.asn1.Asn1[];
    // SignedData: version, digestAlgorithms, contentInfo, [0] IMPLICIT certificates, ...
    const certs = campos.find((c) => c.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && c.type === 0);
    return ((certs?.value ?? []) as forge.asn1.Asn1[]).map((c) => Buffer.from(forge.asn1.toDer(c).getBytes(), 'binary'));
  } catch {
    return [];
  }
}

export function cadeiaIcpGuardada(): string[] {
  const v = parametro(P_CADEIA);
  return v ? v.match(PEM_RE) ?? [] : [];
}

/** Acrescenta certificados de AC à cadeia guardada. Retorna quantos ficaram no total. */
export function guardarCadeiaIcp(pems: string[]): number {
  const todos = new Map<string, string>();
  for (const p of [...cadeiaIcpGuardada(), ...pems]) {
    try { const x = new crypto.X509Certificate(p); if (x.ca) todos.set(x.fingerprint256, x.toString()); } catch { /* ignora */ }
  }
  definirParametro(P_CADEIA, [...todos.values()].join(''));
  return todos.size;
}

export function apagarCadeiaIcp() { definirParametro(P_CADEIA, null); }

export function verificarServidorSefaz(): boolean { return parametro(P_VERIFICAR) !== '0'; }
export function definirVerificacaoServidor(verificar: boolean) { definirParametro(P_VERIFICAR, verificar ? null : '0'); }

function listaCa(tipo: 'default' | 'system'): string[] {
  try {
    if (typeof tls.getCACertificates === 'function') return tls.getCACertificates(tipo);
  } catch { /* sistema sem acesso ao repositório */ }
  return tipo === 'default' ? [...tls.rootCertificates] : [];
}

/** Lista de autoridades usada só na conexão com a SEFAZ. */
export function autoridadesSefaz(): string[] {
  return [...new Set([...PEMS_EMBUTIDOS, ...listaCa('default'), ...listaCa('system'), ...cadeiaIcpGuardada()])];
}

/**
 * Mantém só os certificados que encadeiam, com assinatura válida, até uma das raízes confiáveis.
 * Usado no download pela internet (http), para que um arquivo adulterado no caminho não acrescente nada.
 */
export function encadeadosAte(pems: string[], raizes: string[] = RAIZES_EMBUTIDAS): string[] {
  const confiaveis = new Map<string, crypto.X509Certificate>();
  for (const r of raizes) { const x = new crypto.X509Certificate(r); confiaveis.set(x.fingerprint256, x); }
  const pendentes = new Map<string, crypto.X509Certificate>();
  for (const p of pems) { try { const x = new crypto.X509Certificate(p); if (x.ca) pendentes.set(x.fingerprint256, x); } catch { /* ignora */ } }
  const aceitos: string[] = [];
  let mudou = true;
  while (mudou) { // várias passadas: AC de 2º nível entra depois da AC que a emitiu
    mudou = false;
    for (const [fp, x] of pendentes) {
      if (confiaveis.has(fp)) { pendentes.delete(fp); continue; }
      const emissor = [...confiaveis.values()].find((c) => x.checkIssued(c) && x.verify(c.publicKey));
      if (emissor) { confiaveis.set(fp, x); aceitos.push(x.toString()); pendentes.delete(fp); mudou = true; }
    }
  }
  return aceitos;
}

/** Texto curto para a falha de um download (o fetch do Node esconde o motivo em error.cause). */
function motivo(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const codigo = err.cause?.code ?? (err as any).code;
  if (err.name === 'TimeoutError' || codigo === 'UND_ERR_CONNECT_TIMEOUT') return 'tempo esgotado';
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') return 'endereço não encontrado (sem internet ou bloqueado)';
  if (codigo === 'ECONNREFUSED' || codigo === 'ECONNRESET') return 'conexão recusada (firewall ou proxy?)';
  return codigo ? `${err.cause?.message ?? err.message} (${codigo})` : err.cause?.message ?? err.message;
}

/**
 * Baixa o pacote de ACs da ICP-Brasil do repositório oficial do ITI e guarda as ACs que encadeiam
 * até uma raiz embutida (útil quando uma AC nova passa a emitir certificados para os servidores da SEFAZ).
 */
export async function baixarCadeiaIcp(baixar: (url: string) => Promise<Buffer> = baixarUrl, raizes?: string[]):
  Promise<{ guardados: number; total: number; lidos: number; falhas: string[] }> {
  const antes = cadeiaIcpGuardada().length;
  const url = process.env.SEFAZ_CADEIA_URL_TESTE ?? URL_ACCOMPACTADO; // teste automatizado
  const falhas: string[] = [];
  let lidos: string[] = [];
  try {
    lidos = extrairCertificadosAc(await baixar(url));
    if (!lidos.length) falhas.push('o arquivo baixado não tem certificados de AC');
  } catch (e) {
    falhas.push(`não foi possível baixar ${url}: ${motivo(e)}`);
  }
  const validos = encadeadosAte(lidos, raizes);
  if (lidos.length && !validos.length) falhas.push('nenhum certificado do arquivo encadeia até as raízes ICP-Brasil do sistema');
  const total = validos.length ? guardarCadeiaIcp(validos) : antes;
  return { guardados: total - antes, total, lidos: lidos.length, falhas };
}

async function baixarUrl(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`o site respondeu HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function statusConfianca() {
  const cadeia = cadeiaIcpGuardada().map((p) => new crypto.X509Certificate(p));
  return {
    verificarServidor: verificarServidorSefaz(),
    embutida: CADEIA_ICP_EMBUTIDA.map((c) => ({ nome: c.nome, tipo: c.tipo, validoAte: c.validoAte })),
    urlRepositorio: URL_REPOSITORIO_ITI,
    urlPacote: URL_ACCOMPACTADO,
    cadeiaIcp: cadeia.length,
    raizesIcp: cadeia.filter((x) => x.subject === x.issuer).map((x) => (x.subject.match(/CN=([^\n]+)/)?.[1] ?? x.subject)),
    autoridadesDoSistema: listaCa('system').length,
  };
}
