import crypto from 'node:crypto';
import { db } from '../db.js';
import { ErroNegocio, certificadoDaEmpresa } from '../servicos/emissao.js';
import { ErroSefaz } from '../nfe/sefaz-an.js';
import { SefazCte, urlCte } from './sefaz-cte.js';
import {
  UF_CODIGO, NS_CTE, VERSAO, montarChave, montarCte, assinar, dataHora, lerRetorno, partesDaNfe, montarEventoCte, detalheCancelamento,
  type DadosCte, type Parte,
} from './xml-cte.js';

/**
 * Emissão do CT-e na SEFAZ a partir do rascunho: número e chave são reservados na primeira tentativa
 * (por empresa, ambiente e série) e mantidos nas seguintes, para não pular numeração nem duplicar a nota.
 */

const VER_PROC = 'Kontor Transportadora';
const UF_POR_CODIGO = Object.fromEntries(Object.entries(UF_CODIGO).map(([uf, c]) => [c, uf]));
export const ufDaEmpresa = (e: any): string => e.uf || UF_POR_CODIGO[String(e.cod_municipio ?? '').slice(0, 2)] || '';
const soDig = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** CRT do CT-e: 1 Simples Nacional, 3 regime normal, 4 MEI (op_simp_nac: 1 não optante, 2 MEI, 3 ME/EPP). */
const crtDa = (op: number): 1 | 3 | 4 => (op === 1 ? 3 : op === 2 ? 4 : 1);

/** O que falta no cadastro da empresa para emitir CT-e/MDF-e. */
export function pendenciasEmitente(e: any): string[] {
  const p: string[] = [];
  if (soDig(e.documento).length !== 14) p.push('A empresa emitente precisa ser CNPJ.');
  if (!e.inscricao_estadual) p.push('Inscrição estadual da empresa (Dados do emitente).');
  if (soDig(e.rntrc).length !== 8) p.push('RNTRC da empresa com 8 dígitos (Dados do emitente).');
  if (!e.logradouro || !e.bairro || !e.cidade) p.push('Endereço da empresa: logradouro, bairro e cidade (Dados do emitente).');
  if (!ufDaEmpresa(e)) p.push('UF da empresa.');
  if (!e.cert_validade) p.push('A empresa não tem certificado A1 cadastrado.');
  else if (e.cert_validade < new Date().toISOString().slice(0, 10)) p.push('O certificado A1 da empresa está vencido.');
  return p;
}

function enderecoDoCadastro(x: any) {
  return { logradouro: x.logradouro ?? '', numero: x.numero ?? x.numero_end ?? 'SN', complemento: x.complemento, bairro: x.bairro ?? '', codMunicipio: x.cod_municipio ?? '', municipio: x.cidade ?? '', cep: x.cep, uf: x.uf ?? '' };
}

/** Partes do CT-e a partir do XML da primeira NF-e da viagem (remetente = emitente da nota). */
export function partesDaViagem(viagemId: number): { remetente: Parte; destinatario: Parte } | null {
  const n = db.prepare('SELECT xml FROM viagem_nfes WHERE viagem_id = ? AND xml IS NOT NULL ORDER BY id LIMIT 1').get(viagemId) as any;
  return n ? partesDaNfe(n.xml) : null;
}

export function pendenciasPartes(viagemId: number): string[] {
  const p = partesDaViagem(viagemId);
  if (!p) return [];
  const faltas: string[] = [];
  for (const [nome, x] of [['remetente', p.remetente], ['destinatário', p.destinatario]] as const) {
    if (!x.documento || !x.endereco.logradouro || soDig(x.endereco.codMunicipio).length !== 7) faltas.push(`Endereço completo do ${nome} no XML da NF-e.`);
  }
  return faltas;
}

function montarDados(c: any, e: any, numero: number, codigo: string, chave: string, dhEmi: string): DadosCte {
  const tpAmb = e.ambiente as 1 | 2;
  const uf = ufDaEmpresa(e);
  const partes = partesDaViagem(c.viagem_id);
  if (!partes) throw new ErroNegocio('A viagem precisa de ao menos uma NF-e com XML para emitir o CT-e.');
  const tom = db.prepare('SELECT * FROM embarcadores WHERE id = ?').get(c.embarcador_id) as any;
  const chaves = (db.prepare('SELECT chave FROM viagem_nfes WHERE viagem_id = ? ORDER BY id').all(c.viagem_id) as any[]).map((x) => x.chave);
  const toma = c.tomador_papel === 'DESTINATARIO' ? 3 : c.tomador_papel === 'OUTROS' ? 4 : 0;
  return {
    tpAmb, chave, codigo, numero, serie: c.serie, dhEmi, verProc: VER_PROC, cfop: c.cfop, natOp: 'PRESTACAO DE SERVICO DE TRANSPORTE',
    emitente: { cnpj: e.documento, ie: e.inscricao_estadual, nome: e.razao_social, fantasia: e.nome_fantasia, fone: e.fone, crt: crtDa(e.op_simp_nac),
      endereco: { ...enderecoDoCadastro(e), numero: e.numero_end || 'SN', uf } },
    inicio: { ibge: c.origem_ibge, municipio: c.origem_cidade, uf: c.origem_uf },
    fim: { ibge: c.destino_ibge, municipio: c.destino_cidade, uf: c.destino_uf },
    toma, indIEToma: tom.ind_contribuinte,
    tomador: toma === 4 ? { documento: tom.documento, ie: tom.inscricao_estadual, nome: tom.nome, fone: tom.fone, email: tom.email, endereco: enderecoDoCadastro(tom) } : undefined,
    remetente: partes.remetente, destinatario: partes.destinatario,
    valorPrestacao: c.valor_prestacao, icms: { cst: c.cst_icms, aliquota: c.aliquota_icms },
    carga: { valor: c.valor_carga, produto: c.produto ?? 'DIVERSOS', pesoKg: c.peso_kg },
    chavesNfe: chaves, rntrc: e.rntrc, observacao: c.observacao,
    qrCodeUrl: urlCte(uf, tpAmb, 'qrcode'),
  };
}

/** Reserva número e chave (uma vez); se o mês mudou desde a reserva, só a chave é refeita. */
function reservarNumero(c: any, e: any) {
  const tpAmb = e.ambiente;
  const uf = ufDaEmpresa(e);
  const agora = new Date(Date.now() - 3 * 3600e3);
  const aamm = agora.toISOString().slice(2, 4) + agora.toISOString().slice(5, 7);
  let { numero, cct } = c;
  if (!numero || c.tp_amb !== tpAmb) {
    const r = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 n FROM ctes WHERE empresa_id = ? AND tp_amb = ? AND serie = ?').get(c.empresa_id, tpAmb, c.serie) as any;
    numero = r.n;
    do cct = String(crypto.randomInt(1, 99_999_999)).padStart(8, '0'); while (Number(cct) === numero);
  }
  const chave = montarChave({ uf, aamm, cnpj: soDig(e.documento), modelo: '57', serie: c.serie, numero, codigo: cct });
  db.prepare('UPDATE ctes SET numero = ?, cct = ?, chave = ?, tp_amb = ? WHERE id = ?').run(numero, cct, chave, tpAmb, c.id);
  return { numero, cct, chave };
}

const cteProc = (cteAssinado: string, prot: string) => `<?xml version="1.0" encoding="UTF-8"?><cteProc xmlns="${NS_CTE}" versao="${VERSAO}">${cteAssinado.replace(/^<\?xml[^>]*\?>/, '')}${prot}</cteProc>`;

function marcarAutorizado(id: number, xmlAssinado: string, r: { nProt?: string; dhRecbto?: string; protocoloXml?: string }) {
  db.prepare("UPDATE ctes SET status = 'AUTORIZADO', protocolo = ?, autorizado_em = ?, xml = ?, ultimo_retorno = NULL WHERE id = ?")
    .run(r.nProt ?? null, r.dhRecbto ?? new Date().toISOString(), r.protocoloXml ? cteProc(xmlAssinado, r.protocoloXml) : xmlAssinado, id);
}

export async function transmitirCte(cteId: number, pendencias: string[]) {
  const c = db.prepare('SELECT * FROM ctes WHERE id = ?').get(cteId) as any;
  if (c.status !== 'RASCUNHO') throw new ErroNegocio('Este CT-e não está em rascunho.');
  if (pendencias.length) throw new ErroNegocio(`Antes de transmitir: ${pendencias.join(' ')}`);
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const cert = certificadoDaEmpresa(e);
  const { numero, cct, chave } = reservarNumero(c, e);
  const dhEmi = dataHora(new Date(Date.now() - 60_000));
  const xml = assinar(montarCte(montarDados({ ...c, numero }, e, numero, cct, chave, dhEmi)), 'infCte', cert);
  db.prepare('UPDATE ctes SET xml = ?, dh_emissao = ? WHERE id = ?').run(xml, dhEmi, c.id);
  const uf = ufDaEmpresa(e);
  const ws = new SefazCte(cert, uf, e.ambiente);
  try {
    let r = lerRetorno(await ws.autorizar(xml), 'retCTe');
    // duplicidade: a SEFAZ já tem esta chave (envio anterior sem resposta) — busca o protocolo
    if (r.cStat === '204') {
      const s = lerRetorno(await ws.consulta(chave), 'retConsSitCTe');
      if (['100', '150'].includes(s.cStat)) r = s;
    }
    if (['100', '150'].includes(r.cStat)) { marcarAutorizado(c.id, xml, r); return { autorizado: true, cStat: r.cStat, xMotivo: r.xMotivo, numero, chave }; }
    const motivo = `${r.cStat} - ${r.xMotivo}`;
    db.prepare('UPDATE ctes SET ultimo_retorno = ? WHERE id = ?').run(motivo, c.id);
    throw new ErroNegocio(`A SEFAZ não autorizou o CT-e nº ${numero}: ${motivo}`);
  } catch (err) {
    if (err instanceof ErroSefaz) {
      db.prepare('UPDATE ctes SET ultimo_retorno = ? WHERE id = ?').run(err.message, c.id);
      throw new ErroNegocio(`${err.message} O número ${numero} fica reservado: ao transmitir de novo, o Kontor confere na SEFAZ se ele já foi autorizado.`);
    }
    throw err;
  } finally { ws.fechar(); }
}

export async function cancelarCteAutorizado(cteId: number, justificativa: string) {
  const c = db.prepare('SELECT * FROM ctes WHERE id = ?').get(cteId) as any;
  if (c.status !== 'AUTORIZADO') throw new ErroNegocio('Só CT-e autorizado é cancelado na SEFAZ.');
  const just = justificativa.trim();
  if (just.length < 15 || just.length > 255) throw new ErroNegocio('A justificativa do cancelamento deve ter de 15 a 255 caracteres.');
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const cert = certificadoDaEmpresa(e);
  const ev = assinar(montarEventoCte({ tpAmb: c.tp_amb, cnpj: e.documento, chave: c.chave, tpEvento: '110111', nSeq: 1, detalhe: detalheCancelamento(c.protocolo, just) }), 'infEvento', cert);
  const ws = new SefazCte(cert, ufDaEmpresa(e), c.tp_amb);
  try {
    const r = lerRetorno(await ws.evento(ev), 'retEventoCTe');
    if (!['134', '135', '136'].includes(r.cStat)) throw new ErroNegocio(`A SEFAZ recusou o cancelamento: ${r.cStat} - ${r.xMotivo}`);
    db.prepare("UPDATE ctes SET status = 'CANCELADO', cancelamento_protocolo = ?, cancelamento_xml = ?, cancelado_em = ? WHERE id = ?").run(r.nProt ?? null, ev, r.dhRecbto ?? new Date().toISOString(), c.id);
    return r;
  } catch (err) {
    if (err instanceof ErroSefaz) throw new ErroNegocio(err.message);
    throw err;
  } finally { ws.fechar(); }
}

/** Teste de comunicação: status do serviço de CT-e da UF da empresa, no ambiente configurado. */
export async function statusServicoCte(empresaId: number) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  const cert = certificadoDaEmpresa(e);
  const uf = ufDaEmpresa(e);
  if (!uf) throw new ErroNegocio('Informe a UF da empresa.');
  const ws = new SefazCte(cert, uf, e.ambiente);
  try {
    const r = lerRetorno(await ws.status(), 'retConsStatServCTe');
    return { ...r, ambiente: e.ambiente === 1 ? 'Produção' : 'Homologação', uf };
  } catch (err) {
    if (err instanceof ErroSefaz) throw new ErroNegocio(err.message);
    throw err;
  } finally { ws.fechar(); }
}
