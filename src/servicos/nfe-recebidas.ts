import { z } from 'zod';
import { db } from '../db.js';
import { lerNfe } from '../nfe/leitura.js';
import type { CertificadoA1 } from '../nfse/certificado.js';
import { cadeiaIcpGuardada, baixarCadeiaIcp } from '../nfe/confianca.js';
import { EVENTOS_CANCELAMENTO, ErroSefaz, SefazAN, lerDocumento, type DocDistribuido } from '../nfe/sefaz-an.js';
import { ErroNegocio, certificadoDaEmpresa } from './emissao.js';
import { OpcoesImportacao, importarCompraXml } from './compras.js';

/**
 * NF-e de entrada direto da SEFAZ.
 *
 * Cada busca pede ao Ambiente Nacional os documentos novos desde o último NSU da empresa,
 * guarda resumos/XMLs/cancelamentos em nfe_recebidas e registra a Ciência da Operação nas
 * notas que ainda não têm o XML completo (é ela que libera o download do XML nas buscas seguintes).
 * A importação para Compras reaproveita importarCompraXml.
 */

const ESPERA_MS = 61 * 60_000;          // regra da SEFAZ: 1 hora quando não há documentos novos
const MAX_LOTES = 20;                   // até 50 documentos por lote
const MAX_CIENCIAS = 100;               // por busca, em lotes de 20
const TP_AMB = 1 as const;              // as notas recebidas só existem em produção

type Situacao = 'AUTORIZADA' | 'DENEGADA' | 'CANCELADA';
const SIT_RESUMO: Record<string, Situacao> = { 1: 'AUTORIZADA', 2: 'DENEGADA', 3: 'CANCELADA' };

const emAndamento = new Set<number>();
const esperaPorErro = new Map<number, number>(); // só para a busca automática: não insiste a cada 10 min num erro

export interface ResultadoBusca {
  consultou: boolean;
  proximaConsulta: string | null;
  novas: number;
  completas: number;
  cancelamentos: number;
  ciencias: number;
  cienciasRecusadas: number;
  aviso: string | null;
  resumo: string;
}

function empresaComDoc(empresaId: number) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!e) throw new ErroNegocio('Empresa não encontrada.', 404);
  return e;
}

function codigoUf(e: any): string {
  const c = String(e.cod_municipio ?? '').slice(0, 2);
  if (!/^[1-5]\d$/.test(c)) throw new ErroNegocio('Cadastre o município (código IBGE) da empresa para consultar a SEFAZ.');
  return c;
}

function estado(empresaId: number) {
  db.prepare('INSERT OR IGNORE INTO nfe_distribuicao (empresa_id) VALUES (?)').run(empresaId);
  return db.prepare('SELECT * FROM nfe_distribuicao WHERE empresa_id = ?').get(empresaId) as {
    empresa_id: number; ult_nsu: string; proxima_consulta: string | null; ultima_consulta: string | null;
    ultimo_resultado: string | null; ultimo_erro: string | null; automatica: number;
  };
}

const dadosDaChave = (chave: string) => (chave.length === 44
  ? { serie: String(Number(chave.slice(22, 25))), numero: String(Number(chave.slice(25, 34))), emitente_documento: chave.slice(6, 20).replace(/^000(?=\d{11}$)/, '') }
  : { serie: null, numero: null, emitente_documento: null });

function gravarNota(empresaId: number, chave: string, campos: {
  numero?: string | null; serie?: string | null; emitente_documento?: string | null; emitente_nome?: string | null;
  emissao?: string | null; valor?: number | null; situacao: Situacao; xml?: string | null; nsu?: string | null;
}) {
  const base = dadosDaChave(chave);
  const existia = !!db.prepare('SELECT 1 FROM nfe_recebidas WHERE empresa_id = ? AND chave = ?').get(empresaId, chave);
  db.prepare(`INSERT INTO nfe_recebidas (empresa_id, chave, numero, serie, emitente_documento, emitente_nome, emissao, valor, situacao, xml, nsu)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(empresa_id, chave) DO UPDATE SET
      numero = COALESCE(excluded.numero, numero), serie = COALESCE(excluded.serie, serie),
      emitente_documento = COALESCE(excluded.emitente_documento, emitente_documento), emitente_nome = COALESCE(excluded.emitente_nome, emitente_nome),
      emissao = COALESCE(excluded.emissao, emissao), valor = COALESCE(excluded.valor, valor), xml = COALESCE(excluded.xml, xml),
      nsu = COALESCE(excluded.nsu, nsu),
      situacao = CASE WHEN nfe_recebidas.situacao = 'CANCELADA' THEN 'CANCELADA' ELSE excluded.situacao END,
      atualizada_em = datetime('now')`).run(
    empresaId, chave, campos.numero ?? base.numero, campos.serie ?? base.serie, campos.emitente_documento ?? base.emitente_documento,
    campos.emitente_nome ?? null, campos.emissao ?? null, campos.valor ?? null, campos.situacao, campos.xml ?? null, campos.nsu ?? null);
  return !existia;
}

/** Guarda um documento distribuído. Retorna o que ele representou. */
export function processarDocumento(empresaId: number, d: DocDistribuido): 'nova' | 'completa' | 'cancelamento' | 'outro' {
  if (d.tipo === 'resNFe') {
    const c = lerDocumento(d.xml);
    if (!/^\d{44}$/.test(c.chNFe ?? '')) return 'outro';
    const nova = gravarNota(empresaId, c.chNFe, {
      emitente_documento: c.CNPJ ?? c.CPF ?? null, emitente_nome: c.xNome ?? null, emissao: (c.dhEmi ?? '').slice(0, 10) || null,
      valor: c.vNF != null ? Number(c.vNF) : null, situacao: SIT_RESUMO[c.cSitNFe] ?? 'AUTORIZADA', nsu: d.nsu,
    });
    return nova ? 'nova' : 'outro';
  }
  if (d.tipo === 'procNFe') {
    let n: ReturnType<typeof lerNfe>;
    try { n = lerNfe(d.xml); } catch { return 'outro'; }
    const cStat = d.xml.match(/<cStat>(\d+)<\/cStat>/)?.[1];
    gravarNota(empresaId, n.chave, {
      numero: n.numero, serie: n.serie, emitente_documento: n.fornecedor.documento, emitente_nome: n.fornecedor.nome, emissao: n.emissao,
      valor: n.totais.nf, situacao: cStat && ['110', '205', '301', '302', '303'].includes(cStat) ? 'DENEGADA' : 'AUTORIZADA', xml: d.xml, nsu: d.nsu,
    });
    return 'completa';
  }
  if (d.tipo === 'resEvento' || d.tipo === 'procEventoNFe') {
    const c = lerDocumento(d.xml);
    if (EVENTOS_CANCELAMENTO.includes(c.tpEvento) && /^\d{44}$/.test(c.chNFe ?? '')) {
      gravarNota(empresaId, c.chNFe, { situacao: 'CANCELADA' });
      return 'cancelamento';
    }
  }
  return 'outro';
}

/** Cliente com a cadeia ICP-Brasil: na primeira recusa de cadeia, tenta baixar a cadeia oficial e repete uma vez. */
async function comSefaz<T>(cert: CertificadoA1, fn: (cli: SefazAN) => Promise<T>): Promise<T> {
  let cli = new SefazAN(cert);
  try {
    return await fn(cli);
  } catch (e) {
    if (!(e instanceof ErroSefaz) || e.tipo !== 'CADEIA' || cadeiaIcpGuardada().length) throw e;
    const r = await baixarCadeiaIcp().catch(() => ({ guardados: 0 }));
    if (!r.guardados) throw e;
    cli.fechar();
    cli = new SefazAN(cert);
    return await fn(cli);
  } finally {
    cli.fechar();
  }
}

function paraErroNegocio(e: unknown): never {
  if (e instanceof ErroSefaz) {
    if (e.tipo === 'CADEIA') {
      throw new ErroNegocio('O certificado do servidor da SEFAZ não foi reconhecido nem com a cadeia ICP-Brasil embutida no sistema (a SEFAZ pode ter passado a usar uma AC nova). '
        + 'Um administrador pode atualizar em Compras > Notas na SEFAZ > Conexão com a SEFAZ.', 502, { cadeia: true });
    }
    throw new ErroNegocio(e.message, 502);
  }
  throw e;
}

async function enviarCiencias(cli: SefazAN, cert: CertificadoA1, empresa: any): Promise<{ ok: number; recusadas: number }> {
  const pendentes = (db.prepare(`SELECT r.chave FROM nfe_recebidas r
      WHERE r.empresa_id = ? AND r.xml IS NULL AND r.situacao = 'AUTORIZADA' AND r.ciencia_em IS NULL AND r.ciencia_erro IS NULL AND r.oculta = 0
        AND NOT EXISTS (SELECT 1 FROM compras c WHERE c.empresa_id = r.empresa_id AND c.chave_acesso = r.chave)
      ORDER BY r.emissao, r.id LIMIT ?`).all(empresa.id, MAX_CIENCIAS) as { chave: string }[]).map((x) => x.chave);
  let ok = 0, recusadas = 0;
  for (let i = 0; i < pendentes.length; i += 20) {
    const lote = pendentes.slice(i, i + 20);
    const r = await cli.ciencia(cert, TP_AMB, empresa.documento, lote);
    if (r.cStat !== '128') throw new ErroSefaz(`A SEFAZ recusou o lote de Ciência da Operação: ${r.cStat} - ${r.xMotivo}`, 'SEFAZ', r.cStat);
    db.transaction(() => {
      for (const ch of lote) {
        const x = r.porChave.get(ch);
        if (x && ['135', '136', '573'].includes(x.cStat)) { // 573 = já havia ciência registrada
          db.prepare("UPDATE nfe_recebidas SET ciencia_em = datetime('now'), ciencia_erro = NULL, atualizada_em = datetime('now') WHERE empresa_id = ? AND chave = ?").run(empresa.id, ch);
          ok++;
        } else {
          db.prepare("UPDATE nfe_recebidas SET ciencia_erro = ?, atualizada_em = datetime('now') WHERE empresa_id = ? AND chave = ?")
            .run(x ? `${x.cStat} - ${x.xMotivo}` : 'sem retorno da SEFAZ', empresa.id, ch);
          recusadas++;
        }
      }
    })();
  }
  return { ok, recusadas };
}

function textoResumo(r: Omit<ResultadoBusca, 'resumo'>) {
  const partes: string[] = [];
  if (r.novas) partes.push(`${r.novas} nota(s) nova(s)`);
  if (r.completas) partes.push(`${r.completas} XML(s) completo(s)`);
  if (r.cancelamentos) partes.push(`${r.cancelamentos} cancelamento(s)`);
  if (r.ciencias) partes.push(`ciência registrada em ${r.ciencias}`);
  if (r.cienciasRecusadas) partes.push(`${r.cienciasRecusadas} ciência(s) recusada(s)`);
  if (!partes.length) partes.push(r.consultou ? 'nenhum documento novo' : 'aguardando o intervalo da SEFAZ');
  return partes.join(', ') + (r.aviso ? `. ${r.aviso}` : '');
}

/**
 * Busca os documentos novos na SEFAZ e registra a ciência das notas sem XML completo.
 * Respeita o intervalo de 1 hora exigido pela SEFAZ (nesse caso só envia as ciências pendentes).
 */
export async function buscarNaSefaz(empresaId: number, opcoes: { automatica?: boolean } = {}): Promise<ResultadoBusca> {
  const empresa = empresaComDoc(empresaId);
  if (!empresa.cert_pfx_enc) throw new ErroNegocio('Para buscar as notas na SEFAZ, cadastre o certificado A1 da empresa em Empresas > Certificado.');
  if (emAndamento.has(empresaId)) throw new ErroNegocio('Já há uma busca em andamento para esta empresa. Aguarde alguns segundos.', 409);
  const cUF = codigoUf(empresa);
  emAndamento.add(empresaId);
  try {
    const cert = certificadoDaEmpresa(empresa);
    const est = estado(empresaId);
    const r = await comSefaz(cert, async (cli) => {
      const res: Omit<ResultadoBusca, 'resumo'> = { consultou: false, proximaConsulta: est.proxima_consulta, novas: 0, completas: 0, cancelamentos: 0, ciencias: 0, cienciasRecusadas: 0, aviso: null };
      if (!est.proxima_consulta || new Date(est.proxima_consulta).getTime() <= Date.now()) {
        res.consultou = true;
        let ult = est.ult_nsu;
        const aguardar = () => { res.proximaConsulta = new Date(Date.now() + ESPERA_MS).toISOString(); };
        for (let lote = 0; lote < MAX_LOTES; lote++) {
          const ret = await cli.distribuicao(TP_AMB, cUF, empresa.documento, { ultNSU: ult });
          if (ret.cStat === '138') {
            db.transaction(() => {
              for (const d of ret.docs) {
                const t = processarDocumento(empresaId, d);
                if (t === 'nova') res.novas++; else if (t === 'completa') res.completas++; else if (t === 'cancelamento') res.cancelamentos++;
              }
              if (ret.ultNSU) ult = ret.ultNSU;
              db.prepare('UPDATE nfe_distribuicao SET ult_nsu = ? WHERE empresa_id = ?').run(ult, empresaId);
            })();
            if (!ret.maxNSU || Number(ult) >= Number(ret.maxNSU)) { aguardar(); break; }
            if (lote === MAX_LOTES - 1) res.aviso = 'Ainda há documentos na fila; a próxima busca continua de onde parou.';
          } else if (ret.cStat === '137') {
            if (ret.ultNSU) ult = ret.ultNSU;
            aguardar();
            break;
          } else if (ret.cStat === '656') {
            if (Number(ret.ultNSU) > 0) ult = ret.ultNSU;
            aguardar();
            res.aviso = 'A SEFAZ pediu para aguardar 1 hora entre consultas (consumo indevido).';
            break;
          } else {
            throw new ErroSefaz(`A SEFAZ recusou a consulta: ${ret.cStat} - ${ret.xMotivo}`, 'SEFAZ', ret.cStat);
          }
        }
        db.prepare("UPDATE nfe_distribuicao SET ult_nsu = ?, proxima_consulta = ?, ultima_consulta = ? WHERE empresa_id = ?")
          .run(ult, res.proximaConsulta, new Date().toISOString(), empresaId);
      }
      const c = await enviarCiencias(cli, cert, empresa);
      res.ciencias = c.ok;
      res.cienciasRecusadas = c.recusadas;
      return res;
    });
    const resultado = { ...r, resumo: textoResumo(r) };
    db.prepare('UPDATE nfe_distribuicao SET ultimo_resultado = ?, ultimo_erro = NULL WHERE empresa_id = ?').run(resultado.resumo, empresaId);
    esperaPorErro.delete(empresaId);
    return resultado;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare('UPDATE nfe_distribuicao SET ultimo_erro = ? WHERE empresa_id = ?').run(`${new Date().toISOString()}|${msg}`.slice(0, 500), empresaId);
    if (opcoes.automatica) esperaPorErro.set(empresaId, Date.now() + ESPERA_MS);
    return paraErroNegocio(e);
  } finally {
    emAndamento.delete(empresaId);
  }
}

/** Consulta pontual pela chave de acesso (ex.: nota que o fornecedor avisou). */
export async function buscarPorChave(empresaId: number, chave: string) {
  chave = chave.replace(/\D/g, '');
  if (chave.length !== 44) throw new ErroNegocio('A chave de acesso precisa ter 44 dígitos.');
  const empresa = empresaComDoc(empresaId);
  if (!empresa.cert_pfx_enc) throw new ErroNegocio('Para buscar as notas na SEFAZ, cadastre o certificado A1 da empresa em Empresas > Certificado.');
  const cUF = codigoUf(empresa);
  estado(empresaId);
  try {
    const cert = certificadoDaEmpresa(empresa);
    return await comSefaz(cert, async (cli) => {
      const ret = await cli.distribuicao(TP_AMB, cUF, empresa.documento, { chave });
      if (ret.cStat !== '138') {
        const motivo = ret.cStat === '137' || ret.cStat === '640' || ret.cStat === '641'
          ? 'A SEFAZ não encontrou esta nota para o CNPJ da empresa. Confira a chave e se a empresa é a destinatária.'
          : `A SEFAZ respondeu ${ret.cStat} - ${ret.xMotivo}`;
        throw new ErroNegocio(motivo);
      }
      db.transaction(() => { for (const d of ret.docs) processarDocumento(empresaId, d); })();
      await enviarCiencias(cli, cert, empresa);
      return listarRecebidas(empresaId, { todas: true }).notas.find((n) => n.chave === chave) ?? null;
    });
  } catch (e) {
    return paraErroNegocio(e);
  }
}

export type StatusRecebida = 'IMPORTADA' | 'CANCELADA_IMPORTADA' | 'CANCELADA' | 'DENEGADA' | 'PRONTA' | 'CIENCIA_RECUSADA' | 'AGUARDANDO_XML' | 'NOVA';

export function listarRecebidas(empresaId: number, filtro: { todas?: boolean } = {}) {
  const empresa = empresaComDoc(empresaId);
  const est = db.prepare('SELECT * FROM nfe_distribuicao WHERE empresa_id = ?').get(empresaId) as ReturnType<typeof estado> | undefined;
  const linhas = db.prepare(`SELECT r.id, r.chave, r.numero, r.serie, r.emitente_documento, r.emitente_nome, r.emissao, r.valor, r.situacao,
      (r.xml IS NOT NULL) AS tem_xml, r.ciencia_em, r.ciencia_erro, r.oculta, r.recebida_em, c.id AS compra_id
    FROM nfe_recebidas r LEFT JOIN compras c ON c.empresa_id = r.empresa_id AND c.chave_acesso = r.chave
    WHERE r.empresa_id = ? ${filtro.todas ? '' : "AND r.oculta = 0 AND (c.id IS NULL OR r.situacao = 'CANCELADA')"}
    ORDER BY r.emissao DESC, r.id DESC LIMIT 500`).all(empresaId) as any[];
  const notas = linhas.map((l) => {
    const status: StatusRecebida = l.compra_id ? (l.situacao === 'CANCELADA' ? 'CANCELADA_IMPORTADA' : 'IMPORTADA')
      : l.situacao === 'CANCELADA' ? 'CANCELADA' : l.situacao === 'DENEGADA' ? 'DENEGADA'
        : l.tem_xml ? 'PRONTA' : l.ciencia_erro ? 'CIENCIA_RECUSADA' : l.ciencia_em ? 'AGUARDANDO_XML' : 'NOVA';
    return { ...l, tem_xml: !!l.tem_xml, oculta: !!l.oculta, status };
  });
  const [quando, erro] = (est?.ultimo_erro ?? '').split(/\|(.*)/s);
  return {
    temCertificado: !!empresa.cert_pfx_enc,
    certificadoValidade: empresa.cert_validade ?? null,
    automatica: est ? !!est.automatica : true,
    iniciada: !!est,
    ultimaConsulta: est?.ultima_consulta ?? null,
    proximaConsulta: est?.proxima_consulta && new Date(est.proxima_consulta).getTime() > Date.now() ? est.proxima_consulta : null,
    ultimoResultado: est?.ultimo_resultado ?? null,
    ultimoErro: erro ? { quando, mensagem: erro } : null,
    contagem: {
      prontas: notas.filter((n) => n.status === 'PRONTA').length,
      aguardando: notas.filter((n) => n.status === 'AGUARDANDO_XML' || n.status === 'NOVA').length,
      canceladasImportadas: notas.filter((n) => n.status === 'CANCELADA_IMPORTADA').length,
    },
    notas,
  };
}

export const ImportacaoRecebidas = OpcoesImportacao.omit({ xml: true }).extend({
  chaves: z.array(z.string().regex(/^\d{44}$/, 'Chave de acesso inválida')).min(1, 'Escolha ao menos uma nota').max(200),
});

export function importarRecebidas(empresaId: number, usuarioId: number, entrada: z.infer<typeof ImportacaoRecebidas>) {
  const resultados: { chave: string; ok: boolean; mensagem: string; compraId?: number; numero?: string; fornecedor?: string; valor?: number; alertas?: string[] }[] = [];
  for (const chave of entrada.chaves) {
    const r = db.prepare('SELECT xml, situacao, numero, emitente_nome FROM nfe_recebidas WHERE empresa_id = ? AND chave = ?').get(empresaId, chave) as any;
    const nome = r ? `NF ${r.numero ?? ''} — ${r.emitente_nome ?? ''}`.trim() : chave;
    if (!r) { resultados.push({ chave, ok: false, mensagem: `${chave}: nota não encontrada nas recebidas.` }); continue; }
    if (r.situacao !== 'AUTORIZADA') { resultados.push({ chave, ok: false, mensagem: `${nome}: a nota está ${r.situacao === 'CANCELADA' ? 'cancelada' : 'denegada'} na SEFAZ.` }); continue; }
    if (!r.xml) { resultados.push({ chave, ok: false, mensagem: `${nome}: o XML completo ainda não chegou da SEFAZ. Tente após a próxima busca.` }); continue; }
    try {
      const c = importarCompraXml(empresaId, usuarioId, { xml: r.xml, gerarDespesas: entrada.gerarDespesas, categoria: entrada.categoria, tipoDocumentoId: entrada.tipoDocumentoId, parcelas: entrada.parcelas });
      resultados.push({ chave, ok: true, mensagem: `NF ${c.numero} — ${c.fornecedor}`, compraId: c.id, numero: c.numero, fornecedor: c.fornecedor, valor: c.valor, alertas: c.alertas });
    } catch (e) {
      resultados.push({ chave, ok: false, mensagem: `${nome}: ${(e as Error).message}` });
    }
  }
  return { importadas: resultados.filter((x) => x.ok).length, resultados };
}

export function ocultarRecebida(empresaId: number, chave: string, oculta: boolean) {
  const r = db.prepare("UPDATE nfe_recebidas SET oculta = ?, atualizada_em = datetime('now') WHERE empresa_id = ? AND chave = ?").run(oculta ? 1 : 0, empresaId, chave);
  if (!r.changes) throw new ErroNegocio('Nota não encontrada.', 404);
  return { ok: true };
}

/** Libera para nova tentativa as ciências recusadas (enviadas de novo na próxima busca). */
export function liberarCiencias(empresaId: number, chaves?: string[]) {
  const sql = "UPDATE nfe_recebidas SET ciencia_erro = NULL WHERE empresa_id = ? AND ciencia_erro IS NOT NULL";
  const r = chaves?.length
    ? db.prepare(`${sql} AND chave IN (${chaves.map(() => '?').join(',')})`).run(empresaId, ...chaves)
    : db.prepare(sql).run(empresaId);
  return { liberadas: Number(r.changes) };
}

export function configurarBusca(empresaId: number, automatica: boolean) {
  estado(empresaId);
  db.prepare('UPDATE nfe_distribuicao SET automatica = ? WHERE empresa_id = ?').run(automatica ? 1 : 0, empresaId);
  return { ok: true };
}

export function xmlRecebida(empresaId: number, chave: string) {
  const r = db.prepare('SELECT xml FROM nfe_recebidas WHERE empresa_id = ? AND chave = ?').get(empresaId, chave) as { xml: string | null } | undefined;
  if (!r?.xml) throw new ErroNegocio('O XML completo desta nota ainda não chegou da SEFAZ.', 404);
  return { xml: r.xml, nome: `NFe-${chave}.xml` };
}

/**
 * Busca automática (chamada de tempos em tempos pelo servidor): só para empresas em que a busca
 * já foi iniciada pelo menos uma vez, que têm certificado e estão com a busca automática ligada.
 */
export async function buscarAutomaticamente(): Promise<void> {
  const agora = new Date().toISOString();
  const empresas = db.prepare(`SELECT d.empresa_id FROM nfe_distribuicao d JOIN empresas e ON e.id = d.empresa_id
    WHERE d.automatica = 1 AND e.ativo = 1 AND e.cert_pfx_enc IS NOT NULL AND (d.proxima_consulta IS NULL OR d.proxima_consulta <= ?)`).all(agora) as { empresa_id: number }[];
  for (const { empresa_id } of empresas) {
    if ((esperaPorErro.get(empresa_id) ?? 0) > Date.now()) continue;
    try { await buscarNaSefaz(empresa_id, { automatica: true }); } catch { /* erro fica registrado em nfe_distribuicao.ultimo_erro */ }
  }
}
