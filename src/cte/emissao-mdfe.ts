import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ErroNegocio, certificadoDaEmpresa } from '../servicos/emissao.js';
import { ErroSefaz } from '../nfe/sefaz-an.js';
import { autoridadesSefaz, verificarServidorSefaz } from '../nfe/confianca.js';
import type { CertificadoA1 } from '../nfse/certificado.js';
import { postSoap } from './sefaz-cte.js';
import { UF_CODIGO, montarChave, assinar, dataHora, lerRetorno } from './xml-cte.js';
import { NS_MDFE, VERSAO_MDFE, montarMdfe, montarEventoMdfe, detalheEncerramento, detalheCancelamentoMdfe, TP_RODADO, TP_CARROCERIA } from './xml-mdfe.js';
import { ufDaEmpresa, pendenciasEmitente, partesDaViagem } from './emissao-cte.js';

/**
 * MDF-e 3.00 na SVRS (autorizador de todas as UF): autorização síncrona (GZip + Base64), eventos de
 * encerramento e cancelamento, consulta e status. O cabeçalho mdfeCabecMsg leva a UF e a versão.
 */

const URLS: Record<string, Record<string, string>> = {
  '2': { recepcao: 'https://mdfe-homologacao.svrs.rs.gov.br/ws/MDFeRecepcaoSinc/MDFeRecepcaoSinc.asmx', evento: 'https://mdfe-homologacao.svrs.rs.gov.br/ws/MDFeRecepcaoEvento/MDFeRecepcaoEvento.asmx',
    consulta: 'https://mdfe-homologacao.svrs.rs.gov.br/ws/MDFeConsulta/MDFeConsulta.asmx', status: 'https://mdfe-homologacao.svrs.rs.gov.br/ws/MDFeStatusServico/MDFeStatusServico.asmx' },
  '1': { recepcao: 'https://mdfe.svrs.rs.gov.br/ws/MDFeRecepcaoSinc/MDFeRecepcaoSinc.asmx', evento: 'https://mdfe.svrs.rs.gov.br/ws/MDFeRecepcaoEvento/MDFeRecepcaoEvento.asmx',
    consulta: 'https://mdfe.svrs.rs.gov.br/ws/MDFeConsulta/MDFeConsulta.asmx', status: 'https://mdfe.svrs.rs.gov.br/ws/MDFeStatusServico/MDFeStatusServico.asmx' },
};
const QRCODE = 'https://dfe-portal.svrs.rs.gov.br/mdfe/qrCode';
type Servico = 'recepcao' | 'evento' | 'consulta' | 'status';
const OPERACAO: Record<Servico, [string, string]> = {
  recepcao: ['MDFeRecepcaoSinc', 'mdfeRecepcao'], evento: ['MDFeRecepcaoEvento', 'mdfeRecepcaoEvento'],
  consulta: ['MDFeConsulta', 'mdfeConsultaMDF'], status: ['MDFeStatusServico', 'mdfeStatusServicoMDF'],
};
const WSDL = 'http://www.portalfiscal.inf.br/mdfe/wsdl';

export function corpoSoapMdfe(servico: Servico, cUF: string, xml: string) {
  const [op] = OPERACAO[servico];
  const limpo = xml.replace(/^<\?xml[^>]*\?>/, '');
  const dados = servico === 'recepcao' ? zlib.gzipSync(Buffer.from(limpo, 'utf8')).toString('base64') : limpo;
  return `<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Header><mdfeCabecMsg xmlns="${WSDL}/${op}"><cUF>${cUF}</cUF><versaoDados>${VERSAO_MDFE}</versaoDados></mdfeCabecMsg></Header>`
    + `<Body><mdfeDadosMsg xmlns="${WSDL}/${op}">${dados}</mdfeDadosMsg></Body></Envelope>`;
}

class SefazMdfe {
  private agent: https.Agent;
  constructor(cert: CertificadoA1, private uf: string, private tpAmb: 1 | 2) {
    const teste = process.env.SEFAZ_MDFE_URL_TESTE;
    this.agent = new https.Agent({ key: cert.chavePem, cert: cert.cadeiaPem, keepAlive: true, ca: teste ? undefined : autoridadesSefaz(), rejectUnauthorized: !teste && verificarServidorSefaz() });
  }
  fechar() { this.agent.destroy(); }
  enviar(servico: Servico, xml: string) {
    const teste = process.env.SEFAZ_MDFE_URL_TESTE;
    const url = teste ? `${teste}/${servico}` : URLS[String(this.tpAmb)][servico];
    const [op, metodo] = OPERACAO[servico];
    return postSoap(url, `${WSDL}/${op}/${metodo}`, corpoSoapMdfe(servico, UF_CODIGO[this.uf], xml), this.agent);
  }
  status() { return this.enviar('status', `<consStatServMDFe xmlns="${NS_MDFE}" versao="${VERSAO_MDFE}"><tpAmb>${this.tpAmb}</tpAmb><xServ>STATUS</xServ></consStatServMDFe>`); }
  consulta(chave: string) { return this.enviar('consulta', `<consSitMDFe xmlns="${NS_MDFE}" versao="${VERSAO_MDFE}"><tpAmb>${this.tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chMDFe>${chave}</chMDFe></consSitMDFe>`); }
}

const soDig = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const mdfeProc = (assinado: string, prot: string) => `<?xml version="1.0" encoding="UTF-8"?><mdfeProc xmlns="${NS_MDFE}" versao="${VERSAO_MDFE}">${assinado.replace(/^<\?xml[^>]*\?>/, '')}${prot}</mdfeProc>`;
const erroSefaz = (err: unknown) => (err instanceof ErroSefaz ? new ErroNegocio(err.message) : err);

function reservar(m: any, e: any) {
  const tpAmb = e.ambiente;
  const agora = new Date(Date.now() - 3 * 3600e3).toISOString();
  const aamm = agora.slice(2, 4) + agora.slice(5, 7);
  let { numero, cmdf } = m;
  if (!numero || m.tp_amb !== tpAmb) {
    numero = (db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 n FROM mdfes WHERE empresa_id = ? AND tp_amb = ? AND serie = ?').get(m.empresa_id, tpAmb, m.serie) as any).n;
    do cmdf = String(crypto.randomInt(1, 99_999_999)).padStart(8, '0'); while (Number(cmdf) === numero);
  }
  const chave = montarChave({ uf: ufDaEmpresa(e), aamm, cnpj: soDig(e.documento), modelo: '58', serie: m.serie, numero, codigo: cmdf });
  db.prepare('UPDATE mdfes SET numero = ?, cmdf = ?, chave = ?, tp_amb = ? WHERE id = ?').run(numero, cmdf, chave, tpAmb, m.id);
  return { numero, cmdf, chave };
}

export async function transmitirMdfe(mdfeId: number, pendencias: string[]) {
  const m = db.prepare('SELECT * FROM mdfes WHERE id = ?').get(mdfeId) as any;
  if (m.status !== 'RASCUNHO') throw new ErroNegocio('Este MDF-e não está em rascunho.');
  if (pendencias.length) throw new ErroNegocio(`Antes de transmitir: ${pendencias.join(' ')}`);
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(m.empresa_id) as any;
  const p = pendenciasEmitente(e);
  if (p.length) throw new ErroNegocio(`Antes de transmitir: ${p.join(' ')}`);
  const cert = certificadoDaEmpresa(e);
  const uf = ufDaEmpresa(e);
  const v = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(m.veiculo_id) as any;
  const mot = db.prepare('SELECT * FROM motoristas WHERE id = ?').get(m.motorista_id) as any;
  const dono = v.vinculo !== 'PROPRIO' && v.proprietario_id ? db.prepare('SELECT * FROM transportadores WHERE id = ?').get(v.proprietario_id) as any : null;
  const ctes = db.prepare('SELECT c.* FROM mdfe_ctes x JOIN ctes c ON c.id = x.cte_id WHERE x.mdfe_id = ? ORDER BY c.id').all(m.id) as any[];
  const partes = ctes[0] ? partesDaViagem(ctes[0].viagem_id) : null;
  const { numero, cmdf, chave } = reservar(m, e);
  const dhEmi = dataHora(new Date(Date.now() - 60_000));
  const xml = assinar(montarMdfe({
    tpAmb: e.ambiente, chave, codigo: cmdf, numero, serie: m.serie, dhEmi, verProc: 'Kontor Transportadora',
    ufIni: m.uf_ini, ufFim: m.uf_fim, percurso: m.percurso ? m.percurso.split(',') : [],
    carrega: { ibge: m.carregamento_ibge, municipio: m.carregamento_cidade }, descarga: { ibge: m.descarga_ibge, municipio: m.descarga_cidade },
    emitente: { cnpj: e.documento, ie: e.inscricao_estadual, nome: e.razao_social, fantasia: e.nome_fantasia, fone: e.fone, rntrc: e.rntrc,
      endereco: { logradouro: e.logradouro, numero: e.numero_end || 'SN', complemento: e.complemento, bairro: e.bairro, codMunicipio: e.cod_municipio, municipio: e.cidade, cep: e.cep, uf } },
    ciot: m.ciot ? { numero: m.ciot, documento: dono?.documento ?? e.documento } : null,
    veiculo: { placa: v.placa, renavam: v.renavam, tara: v.tara_kg, capKg: v.capacidade_kg, tpRod: TP_RODADO[v.tipo_rodado] ?? '06', tpCar: TP_CARROCERIA[v.tipo_carroceria] ?? '00', uf: v.uf_licenciamento,
      proprietario: dono ? { documento: dono.documento, rntrc: dono.rntrc, nome: dono.nome, ie: dono.inscricao_estadual, uf: dono.uf ?? v.uf_licenciamento, tpProp: v.vinculo === 'AGREGADO' ? '0' : '1' } : null },
    condutor: { nome: mot.nome, cpf: mot.cpf },
    chavesCte: ctes.map((c) => c.chave),
    produto: { descricao: ctes[0]?.produto ?? 'DIVERSOS', cepCarrega: partes?.remetente.endereco.cep, cepDescarga: partes?.destinatario.endereco.cep },
    totais: { valorCarga: ctes.reduce((s, c) => s + c.valor_carga, 0), pesoKg: ctes.reduce((s, c) => s + c.peso_kg, 0) },
    observacao: m.observacao, qrCodeUrl: QRCODE,
  }), 'infMDFe', cert);
  db.prepare('UPDATE mdfes SET xml = ?, dh_emissao = ? WHERE id = ?').run(xml, dhEmi, m.id);
  const ws = new SefazMdfe(cert, uf, e.ambiente);
  try {
    let r = lerRetorno(await ws.enviar('recepcao', xml), 'retMDFe');
    if (r.cStat === '204') { const s = lerRetorno(await ws.consulta(chave), 'retConsSitMDFe'); if (s.cStat === '100') r = s; }
    if (r.cStat === '100') {
      db.prepare("UPDATE mdfes SET status = 'AUTORIZADO', protocolo = ?, autorizado_em = ?, xml = ?, ultimo_retorno = NULL WHERE id = ?")
        .run(r.nProt ?? null, r.dhRecbto ?? new Date().toISOString(), r.protocoloXml ? mdfeProc(xml, r.protocoloXml) : xml, m.id);
      return { autorizado: true, numero, chave };
    }
    const motivo = `${r.cStat} - ${r.xMotivo}`;
    db.prepare('UPDATE mdfes SET ultimo_retorno = ? WHERE id = ?').run(motivo, m.id);
    throw new ErroNegocio(`A SEFAZ não autorizou o MDF-e nº ${numero}: ${motivo}`);
  } catch (err) {
    if (err instanceof ErroSefaz) {
      db.prepare('UPDATE mdfes SET ultimo_retorno = ? WHERE id = ?').run(err.message, m.id);
      throw new ErroNegocio(`${err.message} O número ${numero} fica reservado: ao transmitir de novo, o Kontor confere na SEFAZ se ele já foi autorizado.`);
    }
    throw err;
  } finally { ws.fechar(); }
}

async function evento(m: any, tpEvento: '110112' | '110111', detalhe: string) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(m.empresa_id) as any;
  const cert = certificadoDaEmpresa(e);
  const ev = assinar(montarEventoMdfe({ tpAmb: m.tp_amb, cnpj: e.documento, chave: m.chave, tpEvento, nSeq: 1, detalhe, dhEvento: dataHora(new Date(Date.now() - 60_000)) }), 'infEvento', cert);
  const ws = new SefazMdfe(cert, ufDaEmpresa(e), m.tp_amb);
  try {
    const r = lerRetorno(await ws.enviar('evento', ev), 'retEventoMDFe');
    if (!['135', '136'].includes(r.cStat)) throw new ErroNegocio(`A SEFAZ recusou o evento: ${r.cStat} - ${r.xMotivo}`);
    return { r, ev };
  } catch (err) { throw erroSefaz(err); } finally { ws.fechar(); }
}

export async function encerrarMdfe(mdfeId: number, uf: string, ibge: string, data: string) {
  const m = db.prepare('SELECT * FROM mdfes WHERE id = ?').get(mdfeId) as any;
  if (m.status !== 'AUTORIZADO') throw new ErroNegocio('Só MDF-e autorizado pode ser encerrado.');
  const { r, ev } = await evento(m, '110112', detalheEncerramento(m.protocolo, data, uf, ibge));
  db.prepare("UPDATE mdfes SET status = 'ENCERRADO', encerrado_em = ?, encerramento_uf = ?, encerramento_ibge = ?, evento_protocolo = ?, evento_xml = ? WHERE id = ?").run(data, uf, ibge, r.nProt ?? null, ev, m.id);
}

export async function cancelarMdfeAutorizado(mdfeId: number, justificativa: string) {
  const m = db.prepare('SELECT * FROM mdfes WHERE id = ?').get(mdfeId) as any;
  const j = justificativa.trim();
  if (j.length < 15 || j.length > 255) throw new ErroNegocio('A justificativa do cancelamento deve ter de 15 a 255 caracteres.');
  const { r, ev } = await evento(m, '110111', detalheCancelamentoMdfe(m.protocolo, j));
  db.prepare("UPDATE mdfes SET status = 'CANCELADO', evento_protocolo = ?, evento_xml = ? WHERE id = ?").run(r.nProt ?? null, ev, m.id);
}

export async function statusServicoMdfe(empresaId: number) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  const ws = new SefazMdfe(certificadoDaEmpresa(e), ufDaEmpresa(e), e.ambiente);
  try { return { ...lerRetorno(await ws.status(), 'retConsStatServMDFe'), ambiente: e.ambiente === 1 ? 'Produção' : 'Homologação' }; }
  catch (err) { throw erroSefaz(err); } finally { ws.fechar(); }
}
