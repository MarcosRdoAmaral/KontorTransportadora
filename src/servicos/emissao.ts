import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { decifrar, decifrarTexto } from '../cofre.js';
import type { Usuario } from '../auth.js';
import { lerPfx, type CertificadoA1 } from '../nfse/certificado.js';
import { tipoDoServico, tributacaoEfetiva } from './tributacao.js';
import { montarDps, type DadosDPS } from '../nfse/dps.js';
import { assinarXml } from '../nfse/assinatura.js';
import { montarCancelamento } from '../nfse/evento.js';
import { SefinClient, extrairErros, ungzipB64, type ErroSefin, type RespostaSefin } from '../nfse/sefin.js';
import { lerNfse } from '../nfse/leitura.js';
import { gerarDanfse } from '../nfse/danfse.js';
import { dataHoraBrasilia } from '../nfse/xml.js';
import { limparDoc } from '../nfse/validacao.js';

export class ErroNegocio extends Error {
  constructor(msg: string, public status = 400, public detalhes?: unknown) {
    super(msg);
  }
}

// ---------- Certificados (com cache em memória) ----------

const cacheCert = new Map<number, { chave: string; cert: CertificadoA1 }>();

export function certificadoDaEmpresa(empresa: any): CertificadoA1 {
  if (!empresa.cert_pfx_enc) throw new ErroNegocio('Empresa sem certificado A1 cadastrado.');
  const chave = `${empresa.cert_validade}|${empresa.cert_senha_enc}`;
  const c = cacheCert.get(empresa.id);
  if (c && c.chave === chave) return c.cert;
  let cert: CertificadoA1;
  try {
    cert = lerPfx(decifrar(empresa.cert_pfx_enc), decifrarTexto(empresa.cert_senha_enc));
  } catch (e) {
    if (e instanceof ErroNegocio) throw e;
    if ((e as Error).message.startsWith('Não foi possível abrir')) throw e;
    throw new ErroNegocio('O certificado salvo não pôde ser aberto (comum após restaurar um backup em outro computador). Envie o arquivo .pfx novamente em Empresas > Certificado.', 409);
  }
  if (cert.validoAte < new Date()) throw new ErroNegocio(`Certificado vencido em ${cert.validoAte.toLocaleDateString('pt-BR')}.`);
  cacheCert.set(empresa.id, { chave, cert });
  return cert;
}

function cliente(empresa: any, notaId: number | null): SefinClient {
  const ins = db.prepare('INSERT INTO log_comunicacao (nota_id, metodo, url, status_http, resposta, duracao_ms) VALUES (?,?,?,?,?,?)');
  return new SefinClient(certificadoDaEmpresa(empresa), empresa.ambiente, (r: RespostaSefin) =>
    ins.run(notaId, r.metodo, r.url, r.status, r.bruto.slice(0, 20000), r.duracaoMs),
  );
}

// ---------- Arquivamento dos XML ----------

function arquivar(empresa: any, competencia: string, nome: string, conteudo: string | Buffer) {
  const dir = path.join(config.storageDir, limparDoc(empresa.documento), competencia.slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nome), conteudo);
}

// ---------- Entrada da emissão ----------

export const EntradaEmissao = z.object({
  empresaId: z.number().int(),
  tomadorId: z.number().int().nullish(),
  servicoId: z.number().int().nullish(),
  competencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descricao: z.string().min(1).max(2000),
  valor: z.number().positive(),
  descontoIncondicionado: z.number().min(0).nullish(),
  descontoCondicionado: z.number().min(0).nullish(),
  cTribNac: z.string().nullish(),
  cTribMun: z.string().nullish(),
  cNBS: z.string().nullish(),
  municipioPrestacao: z.string().regex(/^\d{7}$/).nullish(),
  aliquota: z.number().min(0).max(100).nullish(),
  tribISSQN: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
  tpImunidade: z.number().int().nullish(),
  cPaisResult: z.string().nullish(),
  issRetido: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  retencoes: z.object({
    irrf: z.number().min(0).nullish(), cp: z.number().min(0).nullish(), csll: z.number().min(0).nullish(),
    pis: z.number().min(0).nullish(), cofins: z.number().min(0).nullish(),
    pPis: z.number().min(0).max(100).nullish(), pCofins: z.number().min(0).max(100).nullish(),
  }).nullish(),
  infoComplementar: z.string().max(2000).nullish(),
  /** Tipo de documento (tributação) usado nesta nota; em branco vale o do serviço ou o padrão da empresa. */
  tipoDocumentoId: z.number().int().nullish(),
  /** Nota emitida a partir de um orçamento (e, se for o caso, de um item dele). */
  orcamentoId: z.number().int().nullish(),
  orcamentoItemId: z.number().int().nullish(),
  ibscbs: z.object({ indFinal: z.union([z.literal(0), z.literal(1)]), cIndOp: z.string(), indDest: z.union([z.literal(0), z.literal(1)]), cst: z.string(), cClassTrib: z.string() }).nullish(),
  /** Totais aproximados de tributos (Lei 12.741) — usado por empresas não optantes do Simples. */
  pTotTrib: z.object({ fed: z.number().min(0).max(100).nullish(), est: z.number().min(0).max(100).nullish(), mun: z.number().min(0).max(100).nullish() }).nullish(),
});
export type EntradaEmissao = z.infer<typeof EntradaEmissao>;

/**
 * Grupo piscofins da DPS quando há retenção federal. O campo tpRetPisCofins também informa
 * se a CSLL foi retida (3 = PIS/COFINS/CSLL; 4 = PIS/COFINS; 8 = só CSLL; etc.).
 */
export function pisCofinsRetido(e: EntradaEmissao) {
  const r = e.retencoes;
  const pis = (r?.pis ?? 0) > 0, cof = (r?.cofins ?? 0) > 0, csll = (r?.csll ?? 0) > 0;
  if (!pis && !cof && !csll) return undefined;
  const tabela: Record<string, number> = { '111': 3, '110': 4, '100': 5, '010': 6, '011': 7, '001': 8, '101': 9 };
  const tpRet = tabela[`${+pis}${+cof}${+csll}`];
  const base = Math.round(((e.valor - (e.descontoIncondicionado ?? 0)) + Number.EPSILON) * 100) / 100;
  return {
    cst: pis || cof ? '01' : '00',
    base: pis || cof ? base : undefined,
    pPis: pis ? r?.pPis ?? undefined : undefined,
    pCofins: cof ? r?.pCofins ?? undefined : undefined,
    vPis: pis ? r!.pis! : undefined,
    vCofins: cof ? r!.cofins! : undefined,
    tpRet,
  };
}

function montarDadosDps(empresa: any, e: EntradaEmissao, nDPS: number, ambiente: 1 | 2, serie: string): DadosDPS {
  const tomador = e.tomadorId ? (db.prepare('SELECT * FROM tomadores WHERE id = ? AND empresa_id = ?').get(e.tomadorId, empresa.id) as any) : null;
  if (e.tomadorId && !tomador) throw new ErroNegocio('Tomador não encontrado para esta empresa.');
  const servico = e.servicoId ? (db.prepare('SELECT * FROM servicos WHERE id = ? AND empresa_id = ?').get(e.servicoId, empresa.id) as any) : null;
  if (e.servicoId && !servico) throw new ErroNegocio('Serviço não encontrado para esta empresa.');

  const cTribNac = e.cTribNac ?? servico?.c_trib_nac;
  if (!cTribNac) throw new ErroNegocio('Informe o código de tributação nacional (cTribNac) ou escolha um serviço cadastrado.');
  const ibscbs = e.ibscbs ?? (servico?.ibscbs_json ? JSON.parse(servico.ibscbs_json) : undefined);
  if (ibscbs && !(e.cNBS ?? servico?.c_nbs)) {
    throw new ErroNegocio('Com IBS/CBS a Sefin exige o código NBS do serviço (E0322). Edite o serviço em Serviços e escolha o NBS na busca.');
  }
  if (ibscbs && tomador) {
    const falta = [['cep', 'CEP'], ['logradouro', 'logradouro'], ['cod_municipio', 'município']].filter(([c]) => !tomador[c]).map(([, n]) => n);
    if (falta.length) {
      throw new ErroNegocio(`Com IBS/CBS a Sefin exige o endereço completo do tomador (E0234). Complete o cadastro de "${tomador.nome}" em Tomadores — falta: ${falta.join(', ')}. Dica: no cadastro, digite o CNPJ e use a consulta para preencher o endereço.`);
    }
  }

  return {
    tpAmb: ambiente,
    // 1 min no passado evita rejeição por "data de emissão posterior ao processamento" quando o relógio local adianta.
    dhEmi: dataHoraBrasilia(new Date(Date.now() - 60_000)),
    verAplic: config.verAplic,
    serie,
    nDPS,
    dCompet: e.competencia,
    cLocEmi: empresa.cod_municipio,
    prestador: {
      documento: empresa.documento,
      im: empresa.inscricao_municipal || undefined,
      opSimpNac: empresa.op_simp_nac,
      regApTribSN: empresa.reg_ap_trib_sn ?? undefined,
      regEspTrib: empresa.reg_esp_trib,
    },
    tomador: tomador
      ? {
          documento: tomador.tipo_doc === 'SEM' ? undefined : tomador.documento,
          nome: tomador.nome,
          im: tomador.inscricao_municipal || undefined,
          email: tomador.email || undefined,
          fone: tomador.fone || undefined,
          end:
            tomador.cod_municipio && tomador.cep && tomador.logradouro
              ? { cMun: tomador.cod_municipio, cep: tomador.cep, xLgr: tomador.logradouro, nro: tomador.numero || 'S/N', xCpl: tomador.complemento || undefined, xBairro: tomador.bairro || 'Centro' }
              : undefined,
        }
      : undefined,
    servico: {
      cLocPrestacao: e.municipioPrestacao ?? empresa.cod_municipio,
      cTribNac,
      cTribMun: e.cTribMun ?? servico?.c_trib_mun ?? undefined,
      xDescServ: e.descricao,
      cNBS: e.cNBS ?? servico?.c_nbs ?? undefined,
      xInfComp: e.infoComplementar ?? undefined,
    },
    valores: {
      vServ: e.valor,
      vDescIncond: e.descontoIncondicionado ?? undefined,
      vDescCond: e.descontoCondicionado ?? undefined,
      tribISSQN: e.tribISSQN,
      tpImunidade: e.tpImunidade ?? undefined,
      cPaisResult: e.cPaisResult ?? undefined,
      tpRetISSQN: e.issRetido,
      // E0617: não optantes e MEI não informam alíquota (o sistema nacional aplica a do município)
      pAliq: empresa.op_simp_nac === 3 ? e.aliquota ?? servico?.aliquota ?? undefined : undefined,
      vRetIRRF: e.retencoes?.irrf ?? undefined,
      vRetCP: e.retencoes?.cp ?? undefined,
      vRetCSLL: e.retencoes?.csll ?? undefined,
      pisCofins: pisCofinsRetido(e),
      pTotTrib: e.pTotTrib ? { fed: e.pTotTrib.fed ?? 0, est: e.pTotTrib.est ?? 0, mun: e.pTotTrib.mun ?? 0 } : undefined,
      pTotTribSN: empresa.op_simp_nac === 3 && empresa.p_tot_trib_sn != null ? empresa.p_tot_trib_sn : undefined,
    },
    ibscbs,
  };
}

/** Reserva o próximo número de DPS de forma atômica (nunca repete, mesmo com emissões simultâneas). */
function reservarNumero(empresaId: number, ambiente: number, serie: string): number {
  db.prepare('INSERT OR IGNORE INTO sequencias_dps (empresa_id, ambiente, serie, ultimo_numero) VALUES (?,?,?,0)').run(empresaId, ambiente, serie);
  db.prepare('UPDATE sequencias_dps SET ultimo_numero = ultimo_numero + 1 WHERE empresa_id = ? AND ambiente = ? AND serie = ?').run(empresaId, ambiente, serie);
  return (db.prepare('SELECT ultimo_numero AS n FROM sequencias_dps WHERE empresa_id = ? AND ambiente = ? AND serie = ?').get(empresaId, ambiente, serie) as { n: number }).n;
}

// ---------- Fluxo principal ----------

/**
 * Retenções padrão do serviço cadastrado: quando a emissão chega sem nenhuma retenção
 * (ex.: emissão automática ou agendada), aplica os percentuais do cadastro do serviço.
 */
/**
 * Retenção de até R$ 10,00 é dispensada, verificada a cada pagamento e sem acumular com os seguintes
 * (PIS+COFINS+CSLL somados: Lei 10.833/2003, art. 31, § 3º; IRRF: Lei 9.430/1996, art. 67; SC RFB 258/2024).
 */
export function dispensarRetencoes<T extends { pis?: number | null; cofins?: number | null; csll?: number | null; irrf?: number | null }>(r: T): T {
  const pcc = Math.round(((r.pis ?? 0) + (r.cofins ?? 0) + (r.csll ?? 0)) * 100) / 100;
  const out = { ...r };
  if (pcc <= 10) { out.pis = null; out.cofins = null; out.csll = null; }
  if ((r.irrf ?? 0) <= 10) out.irrf = null;
  return out;
}

export function comRetencoesDoServico<T extends EntradaEmissao>(e: T): T {
  // tipo de documento: o escolhido na nota, senão o do serviço, senão o padrão de saída da empresa
  const sv = e.servicoId ? (db.prepare('SELECT tributacao_json, tipo_documento_id FROM servicos WHERE id = ? AND empresa_id = ?').get(e.servicoId, e.empresaId) as any) : null;
  const tipoId = e.tipoDocumentoId ?? tipoDoServico(e.servicoId, e.empresaId);
  const ef = tipoId ? tributacaoEfetiva(tipoId, e.competencia) : null;
  let out: T = tipoId ? { ...e, tipoDocumentoId: tipoId } : e;
  let t = sv?.tributacao_json ? JSON.parse(sv.tributacao_json) : null;
  if (ef?.temPerfil) {
    // o perfil completa o que a nota não trouxe; o grupo IBS/CBS vem sempre do tipo
    out = { ...out, aliquota: out.aliquota ?? ef.aliquota ?? undefined, municipioPrestacao: out.municipioPrestacao ?? ef.municipioPrestacao ?? undefined,
      infoComplementar: out.infoComplementar ?? ef.infoComplementar ?? undefined, ibscbs: out.ibscbs ?? ef.ibscbs ?? undefined,
      pTotTrib: out.pTotTrib ?? (ef.pTotTrib ? { fed: ef.pTotTrib.fed, est: ef.pTotTrib.est, mun: ef.pTotTrib.mun } : undefined) };
    t = { ...(t ?? {}), pPis: ef.pPis, pCofins: ef.pCofins, pCsll: ef.pCsll, pIrrf: ef.pIrrf, pCp: ef.pCp };
  }
  if (!e.servicoId && !ef?.temPerfil) return out;
  const r = out.retencoes;
  if (r && Object.values(r).some((v) => v != null)) return out; // o usuário já definiu as retenções na nota
  if (!t) return out;
  const base = out.valor - (out.descontoIncondicionado ?? 0);
  const v = (pc?: number | null) => (pc ? Math.round(base * pc) / 100 : null);
  const ret = dispensarRetencoes({ pis: v(t.pPis), cofins: v(t.pCofins), csll: v(t.pCsll), irrf: v(t.irrf ?? t.pIrrf), cp: v(t.pCp), pPis: t.pPis ?? null, pCofins: t.pCofins ?? null });
  return Object.values(ret).some((x) => x != null) ? { ...out, retencoes: ret } : out;
}

/**
 * 1. Reserva o nº da DPS e grava a nota como PENDENTE (antes de qualquer chamada HTTP).
 * 2. Monta, assina e envia.
 * 3. Atualiza status. Se a conexão cair, a nota fica ERRO_COMUNICACAO e pode ser
 *    reconciliada pelo Id da DPS — assim nunca se emite duas notas para a mesma cobrança.
 */
export async function emitir(u: Usuario, entrada: EntradaEmissao) {
  entrada = comRetencoesDoServico(entrada);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ? AND ativo = 1').get(entrada.empresaId) as any;
  if (!empresa) throw new ErroNegocio('Empresa não encontrada.', 404);
  if (empresa.modo_emissao === 'PORTAL') throw new ErroNegocio('Esta empresa emite as notas pelo portal (CNPJ e senha). Emita no Emissor Nacional e importe o XML em Notas emitidas.');
  certificadoDaEmpresa(empresa); // falha cedo se o certificado estiver ausente ou vencido

  const notaId = db.transaction(() => {
    const nDPS = reservarNumero(empresa.id, empresa.ambiente, empresa.serie);
    const dados = montarDadosDps(empresa, entrada, nDPS, empresa.ambiente, empresa.serie);
    const { id } = montarDps(dados);
    const r = db
      .prepare(
        `INSERT INTO notas (empresa_id, tomador_id, servico_id, ambiente, serie, n_dps, id_dps, status, competencia, valor_servico, descricao,
          tomador_nome, tomador_documento, payload_json, criado_por, tipo_documento_id) VALUES (?,?,?,?,?,?,?,'PENDENTE',?,?,?,?,?,?,?,?)`,
      )
      .run(
        empresa.id, entrada.tomadorId ?? null, entrada.servicoId ?? null, empresa.ambiente, empresa.serie, nDPS, id,
        entrada.competencia, entrada.valor, entrada.descricao, dados.tomador?.nome ?? null, dados.tomador?.documento ?? null,
        JSON.stringify(entrada), u.id, entrada.tipoDocumentoId ?? null,
      );
    return Number(r.lastInsertRowid);
  })();

  return enviar(notaId);
}

/** (Re)envia uma nota PENDENTE, REJEITADA (após correção) ou com ERRO_COMUNICACAO, mantendo o mesmo nº de DPS. */
export async function enviar(notaId: number, novaEntrada?: EntradaEmissao) {
  let nota = db.prepare('SELECT * FROM notas WHERE id = ?').get(notaId) as any;
  if (!['PENDENTE', 'REJEITADA', 'ERRO_COMUNICACAO'].includes(nota.status)) throw new ErroNegocio(`Nota já está ${nota.status}.`);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(nota.empresa_id) as any;

  if (nota.status === 'ERRO_COMUNICACAO') {
    const rec = await reconciliar(notaId);
    if (rec.status === 'AUTORIZADA') return rec;
    nota = db.prepare('SELECT * FROM notas WHERE id = ?').get(notaId);
  }

  const entrada = novaEntrada ?? EntradaEmissao.parse(JSON.parse(nota.payload_json));
  const dados = montarDadosDps(empresa, entrada, nota.n_dps, nota.ambiente, nota.serie);
  const cert = certificadoDaEmpresa(empresa);
  const { xml } = montarDps(dados);
  const xmlAssinado = assinarXml(xml, 'infDPS', cert);

  db.prepare(
    `UPDATE notas SET xml_dps = ?, payload_json = ?, valor_servico = ?, descricao = ?, competencia = ?, tomador_id = ?, servico_id = ?,
     tomador_nome = ?, tomador_documento = ? WHERE id = ?`,
  ).run(xmlAssinado, JSON.stringify(entrada), entrada.valor, entrada.descricao, entrada.competencia, entrada.tomadorId ?? null,
    entrada.servicoId ?? null, dados.tomador?.nome ?? null, dados.tomador?.documento ?? null, notaId);

  let resp: RespostaSefin;
  try {
    resp = await cliente(empresa, notaId).emitir(xmlAssinado);
  } catch (err: any) {
    marcarErro(notaId, 'ERRO_COMUNICACAO', [{ codigo: 'REDE', descricao: err.message }]);
    return obterNota(notaId);
  }

  if (resp.status >= 200 && resp.status < 300 && resp.corpo?.chaveAcesso) {
    autorizar(notaId, empresa, resp.corpo.chaveAcesso, ungzipB64(resp.corpo.nfseXmlGZipB64), resp.corpo.alertas);
    return obterNota(notaId);
  }

  const erros = extrairErros(resp.corpo);
  if (resp.status >= 500 || resp.status === 0) {
    marcarErro(notaId, 'ERRO_COMUNICACAO', erros.length ? erros : [{ codigo: `HTTP ${resp.status}`, descricao: resp.bruto.slice(0, 500) || 'Sefin indisponível' }]);
    return obterNota(notaId);
  }
  // DPS já convertida em NFS-e anteriormente (ex.: resposta perdida): busca a nota existente.
  if (erros.some((e) => /E0014|já exist/i.test(`${e.codigo} ${e.descricao}`))) {
    const rec = await reconciliar(notaId);
    if (rec.status === 'AUTORIZADA') return rec;
  }
  marcarErro(notaId, 'REJEITADA', erros.length ? erros : [{ codigo: `HTTP ${resp.status}`, descricao: resp.bruto.slice(0, 500) }]);
  return obterNota(notaId);
}

function marcarErro(notaId: number, status: 'REJEITADA' | 'ERRO_COMUNICACAO', erros: ErroSefin[]) {
  db.prepare('UPDATE notas SET status = ?, erros_json = ? WHERE id = ?').run(status, JSON.stringify(erros), notaId);
}

function autorizar(notaId: number, empresa: any, chave: string, xmlNfse: string, alertas?: unknown) {
  const lida = lerNfse(xmlNfse);
  db.prepare(
    `UPDATE notas SET status = 'AUTORIZADA', chave_acesso = ?, xml_nfse = ?, n_nfse = ?, erros_json = NULL, alertas_json = ?, autorizada_em = datetime('now') WHERE id = ?`,
  ).run(chave, xmlNfse, lida.numero, alertas ? JSON.stringify(alertas) : null, notaId);
  arquivar(empresa, lida.dps.dCompet, `NFSe_${lida.numero}_${chave}.xml`, xmlNfse);
}

/** Consulta a Sefin pelo Id da DPS para descobrir se a NFS-e foi gerada. */
export async function reconciliar(notaId: number) {
  const nota = db.prepare('SELECT * FROM notas WHERE id = ?').get(notaId) as any;
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(nota.empresa_id) as any;
  const c = cliente(empresa, notaId);
  const r = await c.consultarDps(nota.id_dps);
  const chave = r.corpo?.chaveAcesso;
  if (r.status === 200 && chave) {
    const n = await c.consultarNfse(chave);
    if (n.status === 200 && n.corpo?.nfseXmlGZipB64) {
      autorizar(notaId, empresa, chave, ungzipB64(n.corpo.nfseXmlGZipB64));
    }
  }
  return obterNota(notaId);
}

/**
 * Exclui uma nota que NÃO foi autorizada (rejeitada, pendente ou sem resposta da Sefin).
 * Autorizadas e canceladas são documentos fiscais e nunca podem ser apagadas — só canceladas.
 * Boletos ligados à nota ficam no sistema, apenas sem o vínculo; a emissão automática do mês volta a ficar livre.
 */
export function excluirNota(notaId: number) {
  const nota = db.prepare('SELECT id, status, chave_acesso FROM notas WHERE id = ?').get(notaId) as any;
  if (!nota) throw new ErroNegocio('Nota não encontrada.');
  if (nota.status === 'AUTORIZADA' || nota.status === 'CANCELADA' || nota.chave_acesso) {
    throw new ErroNegocio('Nota autorizada não pode ser excluída. Se for o caso, cancele a nota.');
  }
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE cobrancas SET nota_id = NULL WHERE nota_id = ?').run(notaId);
    db.prepare('DELETE FROM agenda_execucoes WHERE nota_id = ?').run(notaId);
    db.prepare('DELETE FROM emails_enviados WHERE nota_id = ?').run(notaId);
    db.prepare('DELETE FROM eventos WHERE nota_id = ?').run(notaId);
    db.prepare('DELETE FROM log_comunicacao WHERE nota_id = ?').run(notaId);
    db.prepare('DELETE FROM notas WHERE id = ?').run(notaId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
}

export async function cancelar(u: Usuario, notaId: number, cMotivo: 1 | 2 | 9, xMotivo: string) {
  const nota = db.prepare('SELECT * FROM notas WHERE id = ?').get(notaId) as any;
  if (!nota || nota.status !== 'AUTORIZADA') throw new ErroNegocio('Só é possível cancelar NFS-e autorizada.');
  if (xMotivo.trim().length < 15) throw new ErroNegocio('Descreva o motivo do cancelamento com pelo menos 15 caracteres.');
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(nota.empresa_id) as any;
  const cert = certificadoDaEmpresa(empresa);

  const xml = assinarXml(
    montarCancelamento({
      tpAmb: nota.ambiente, verAplic: config.verAplic, dhEvento: dataHoraBrasilia(new Date(Date.now() - 60_000)),
      documentoAutor: empresa.documento, chNFSe: nota.chave_acesso, cMotivo, xMotivo,
    }),
    'infPedReg',
    cert,
  );
  const ev = db.prepare(`INSERT INTO eventos (nota_id, tipo, status, motivo, xml_pedido, criado_por) VALUES (?, 'CANCELAMENTO', 'ENVIADO', ?, ?, ?)`)
    .run(notaId, `${cMotivo} - ${xMotivo}`, xml, u.id);
  const evId = Number(ev.lastInsertRowid);

  const r = await cliente(empresa, notaId).registrarEvento(nota.chave_acesso, xml);
  if (r.status >= 200 && r.status < 300) {
    const retorno = r.corpo?.eventoXmlGZipB64 ? ungzipB64(r.corpo.eventoXmlGZipB64) : r.bruto;
    db.prepare(`UPDATE eventos SET status = 'REGISTRADO', xml_retorno = ? WHERE id = ?`).run(retorno, evId);
    db.prepare(`UPDATE notas SET status = 'CANCELADA', cancelada_em = datetime('now') WHERE id = ?`).run(notaId);
    arquivar(empresa, nota.competencia, `Cancelamento_${nota.n_nfse}_${nota.chave_acesso}.xml`, retorno);
    return obterNota(notaId);
  }
  const erros = extrairErros(r.corpo);
  db.prepare(`UPDATE eventos SET status = 'REJEITADO', erros_json = ? WHERE id = ?`).run(JSON.stringify(erros), evId);
  throw new ErroNegocio('Cancelamento recusado pela Sefin.', 422, erros);
}

export async function danfse(notaId: number): Promise<Buffer> {
  const nota = db.prepare('SELECT * FROM notas WHERE id = ?').get(notaId) as any;
  if (!nota?.xml_nfse) throw new ErroNegocio('Nota sem XML autorizado.');
  const emp = db.prepare('SELECT logo FROM empresas WHERE id = ?').get(nota.empresa_id) as { logo: Uint8Array | null } | undefined;
  return gerarDanfse(lerNfse(nota.xml_nfse), { cancelada: nota.status === 'CANCELADA', logo: emp?.logo ? Buffer.from(emp.logo) : null });
}

export function obterNota(id: number) {
  const n = db.prepare('SELECT * FROM notas WHERE id = ?').get(id) as any;
  if (!n) return null;
  return {
    ...n,
    payload: JSON.parse(n.payload_json),
    erros: n.erros_json ? JSON.parse(n.erros_json) : [],
    alertas: n.alertas_json ? JSON.parse(n.alertas_json) : [],
    eventos: db.prepare('SELECT id, tipo, status, motivo, erros_json, criado_em FROM eventos WHERE nota_id = ? ORDER BY id').all(id),
    tomador_email: n.tomador_id ? (db.prepare('SELECT email FROM tomadores WHERE id = ?').get(n.tomador_id) as any)?.email ?? null : null,
    tomador_fone: n.tomador_id ? (db.prepare('SELECT fone FROM tomadores WHERE id = ?').get(n.tomador_id) as any)?.fone ?? null : null,
    empresa_nome: (db.prepare('SELECT nome_fantasia, razao_social FROM empresas WHERE id = ?').get(n.empresa_id) as any),
    emails: db.prepare('SELECT id, para, status, erro, criado_em FROM emails_enviados WHERE nota_id = ? ORDER BY id DESC').all(id),
    payload_json: undefined,
  };
}

/**
 * Importa o XML de uma NFS-e emitida no portal. Confere se a nota é da empresa, evita duplicar
 * e liga ao cliente pelo CPF/CNPJ quando ele já estiver cadastrado.
 */
export function importarNotaXml(empresaId: number, usuarioId: number, xml: string) {
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!empresa) throw new ErroNegocio('Empresa não encontrada.', 404);
  let n: ReturnType<typeof lerNfse>;
  try { n = lerNfse(xml); } catch (e: any) { throw new ErroNegocio(e.message ?? 'XML inválido.'); }
  if (!n.chave || !n.numero) throw new ErroNegocio('O XML não traz a chave de acesso e o número da NFS-e. Baixe o XML da nota autorizada no portal.');
  if (n.emitente.documento !== empresa.documento) throw new ErroNegocio(`Esta nota foi emitida por outro CNPJ/CPF (${n.emitente.documento}), não por ${empresa.documento}.`);
  if (db.prepare('SELECT 1 FROM notas WHERE chave_acesso = ?').get(n.chave)) throw new ErroNegocio('Esta nota já foi importada.');
  const tomador = n.tomador?.documento ? (db.prepare('SELECT id FROM tomadores WHERE empresa_id = ? AND documento = ?').get(empresaId, n.tomador.documento) as any) : null;
  const cancelada = n.cStat === '101' || /cancel/i.test(String(n.cStat));
  const idDps = n.dps.id || `IMP${n.chave}`;
  const id = Number(db.prepare(`INSERT INTO notas (empresa_id, tomador_id, ambiente, serie, n_dps, id_dps, status, competencia, valor_servico, descricao,
      tomador_nome, tomador_documento, payload_json, xml_nfse, chave_acesso, n_nfse, criado_por, autorizada_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    empresaId, tomador?.id ?? null, n.tpAmb === 1 ? 1 : 2, n.dps.serie ?? '', Number(n.dps.nDPS) || 0, idDps, cancelada ? 'CANCELADA' : 'AUTORIZADA',
    n.dps.dCompet, n.valores.vServ, n.servico.descricao ?? '', n.tomador?.nome ?? null, n.tomador?.documento ?? null,
    JSON.stringify({ importadoDoPortal: true }), xml, n.chave, n.numero, usuarioId, (n.dps.dhEmi ?? '').slice(0, 19).replace('T', ' ') || null,
  ).lastInsertRowid);
  return { id, numero: n.numero, valor: n.valores.vServ, tomador: n.tomador?.nome ?? null, clienteCadastrado: !!tomador };
}
