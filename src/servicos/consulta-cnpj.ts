import { ErroNegocio } from './emissao.js';
import { cnpjValido, limparDoc, soDigitos } from '../nfse/validacao.js';

export interface DadosCnpj {
  documento: string;
  razao_social: string;
  nome_fantasia: string | null;
  situacao: string | null;
  ativa: boolean;
  cep: string | null;
  cod_municipio: string | null;
  municipio: string | null;
  uf: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  email: string | null;
  fone: string | null;
  /** 1 não optante, 2 MEI, 3 Simples ME/EPP; null quando a base não informa */
  op_simp_nac: 1 | 2 | 3 | null;
  cnae: string | null;
  fonte: string;
}

// Bases públicas com o mesmo formato (a segunda é a reserva da primeira).
const FONTES = [
  { nome: 'BrasilAPI', url: (c: string) => `https://brasilapi.com.br/api/cnpj/v1/${c}` },
  { nome: 'Minha Receita', url: (c: string) => `https://minhareceita.org/${c}` },
];

const cache = new Map<string, { ate: number; dados: DadosCnpj }>();
const DEZ_MIN = 10 * 60_000;

async function buscarJson(url: string, ms = 10_000): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
  let json: any = null;
  try { json = await r.json(); } catch { /* corpo vazio ou não-JSON */ }
  return { status: r.status, json };
}

const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function normalizar(d: any, cnpj: string, fonte: string): DadosCnpj {
  const tipo = texto(d.descricao_tipo_de_logradouro);
  const log = texto(d.logradouro);
  const logradouro = log && tipo && !log.toUpperCase().startsWith(tipo.toUpperCase()) ? `${tipo} ${log}` : log;
  const ibge = d.codigo_municipio_ibge != null ? String(d.codigo_municipio_ibge).padStart(7, '0') : null;
  const sit = texto(d.descricao_situacao_cadastral);
  let regime: 1 | 2 | 3 | null = null;
  if (d.opcao_pelo_mei === true) regime = 2;
  else if (d.opcao_pelo_simples === true) regime = 3;
  else if (d.opcao_pelo_simples === false) regime = 1;
  const cep = soDigitos(d.cep);
  return {
    documento: cnpj,
    razao_social: texto(d.razao_social) ?? '',
    nome_fantasia: texto(d.nome_fantasia),
    situacao: sit,
    ativa: sit ? /ativa/i.test(sit) : true,
    cep: cep ? cep.padStart(8, '0') : null,
    cod_municipio: ibge && /^\d{7}$/.test(ibge) && ibge !== '0000000' ? ibge : null,
    municipio: texto(d.municipio),
    uf: texto(d.uf),
    logradouro,
    numero: texto(d.numero),
    complemento: texto(d.complemento),
    bairro: texto(d.bairro),
    email: texto(d.email)?.toLowerCase() ?? null,
    fone: soDigitos(d.ddd_telefone_1) || null,
    op_simp_nac: regime,
    cnae: texto(d.cnae_fiscal),
    fonte,
  };
}

/** Consulta dados cadastrais públicos do CNPJ (Receita Federal) para preencher cadastros. */
export async function consultarCnpj(entrada: string): Promise<DadosCnpj> {
  const cnpj = limparDoc(entrada);
  if (cnpj.length !== 14 || !cnpjValido(cnpj)) throw new ErroNegocio('CNPJ inválido. Confira os dígitos.');

  const guardado = cache.get(cnpj);
  if (guardado && guardado.ate > Date.now()) return guardado.dados;

  let naoEncontrado = false;
  let dados: DadosCnpj | null = null;
  for (const f of FONTES) {
    try {
      const r = await buscarJson(f.url(cnpj));
      if (r.status === 404) { naoEncontrado = true; continue; }
      if (r.status !== 200 || !r.json?.razao_social) continue;
      dados = normalizar(r.json, cnpj, f.nome);
      break;
    } catch { /* rede/tempo esgotado: tenta a próxima fonte */ }
  }
  if (!dados) {
    if (naoEncontrado) throw new ErroNegocio('CNPJ não encontrado na base da Receita Federal. Preencha manualmente.', 404);
    throw new ErroNegocio('Não foi possível consultar o CNPJ agora (sem internet ou serviço fora do ar). Preencha manualmente.', 502);
  }

  // Quando a base não traz o código IBGE, o logradouro ou o bairro, completa pelo CEP (ViaCEP).
  if ((!dados.cod_municipio || !dados.logradouro || !dados.bairro) && dados.cep) {
    try {
      const r = await buscarJson(`https://viacep.com.br/ws/${dados.cep}/json/`, 6_000);
      if (r.status === 200 && r.json && !r.json.erro) {
        const ibge = String(r.json.ibge ?? '');
        if (!dados.cod_municipio && /^\d{7}$/.test(ibge)) dados.cod_municipio = ibge;
        if (!dados.logradouro) dados.logradouro = texto(r.json.logradouro);
        if (!dados.bairro) dados.bairro = texto(r.json.bairro);
        if (!dados.uf) dados.uf = texto(r.json.uf);
        if (!dados.municipio) dados.municipio = texto(r.json.localidade);
      }
    } catch { /* segue sem o complemento; o usuário informa */ }
  }

  cache.set(cnpj, { ate: Date.now() + DEZ_MIN, dados });
  return dados;
}
