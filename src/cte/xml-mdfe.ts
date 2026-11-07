import { esc } from '../nfse/xml.js';
import { UF_CODIGO, dec } from './xml-cte.js';

/** XML do MDF-e 3.00 (modal rodoviário, emitente prestador de serviço de transporte) e dos eventos. */

export const NS_MDFE = 'http://www.portalfiscal.inf.br/mdfe';
export const VERSAO_MDFE = '3.00';

const txt = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const el = (nome: string, valor: unknown) => (valor === undefined || valor === null || valor === '' ? '' : `<${nome}>${esc(String(valor))}</${nome}>`);
const g = (nome: string, ...filhos: string[]) => `<${nome}>${filhos.join('')}</${nome}>`;
const soDig = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const doc = (d: string) => (soDig(d).length === 11 ? el('CPF', soDig(d)) : el('CNPJ', soDig(d)));

export const TP_RODADO: Record<string, string> = { Truck: '01', Toco: '02', 'Cavalo mecânico': '03', VAN: '04', Utilitário: '05', Outros: '06' };
export const TP_CARROCERIA: Record<string, string> = { Aberta: '01', 'Fechada/Baú': '02', Granelera: '03', 'Porta-contêiner': '04', Sider: '05' };

export interface DadosMdfe {
  tpAmb: 1 | 2; chave: string; codigo: string; numero: number; serie: number; dhEmi: string; verProc: string;
  ufIni: string; ufFim: string; percurso: string[];
  carrega: { ibge: string; municipio: string };
  descarga: { ibge: string; municipio: string };
  emitente: { cnpj: string; ie: string; nome: string; fantasia?: string | null; fone?: string | null; rntrc: string;
    endereco: { logradouro: string; numero: string; complemento?: string | null; bairro: string; codMunicipio: string; municipio: string; cep?: string | null; uf: string } };
  ciot?: { numero: string; documento: string } | null;
  veiculo: { placa: string; renavam?: string | null; tara: number; capKg?: number | null; tpRod: string; tpCar: string; uf: string;
    proprietario?: { documento: string; rntrc: string; nome: string; ie?: string | null; uf: string; tpProp: '0' | '1' | '2' } | null };
  condutor: { nome: string; cpf: string };
  chavesCte: string[];
  produto: { descricao: string; cepCarrega?: string | null; cepDescarga?: string | null };
  totais: { valorCarga: number; pesoKg: number };
  observacao?: string | null;
  qrCodeUrl: string;
}

export function montarMdfe(d: DadosMdfe): string {
  const e = d.emitente;
  const ide = g('ide', el('cUF', UF_CODIGO[e.endereco.uf]), el('tpAmb', d.tpAmb), el('tpEmit', '1'), el('mod', '58'), el('serie', d.serie), el('nMDF', d.numero), el('cMDF', d.codigo),
    el('cDV', d.chave.slice(-1)), el('modal', '1'), el('dhEmi', d.dhEmi), el('tpEmis', '1'), el('procEmi', '0'), el('verProc', txt(d.verProc, 20)), el('UFIni', d.ufIni), el('UFFim', d.ufFim),
    g('infMunCarrega', el('cMunCarrega', d.carrega.ibge), el('xMunCarrega', txt(d.carrega.municipio, 60))),
    ...d.percurso.map((uf) => g('infPercurso', el('UFPer', uf))));
  const emit = g('emit', el('CNPJ', soDig(e.cnpj)), el('IE', soDig(e.ie) || e.ie), el('xNome', txt(e.nome, 60)), el('xFant', e.fantasia ? txt(e.fantasia, 60) : ''),
    g('enderEmit', el('xLgr', txt(e.endereco.logradouro, 60)), el('nro', txt(e.endereco.numero || 'SN', 60)), el('xCpl', txt(e.endereco.complemento, 60)), el('xBairro', txt(e.endereco.bairro, 60)),
      el('cMun', e.endereco.codMunicipio), el('xMun', txt(e.endereco.municipio, 60)), el('CEP', soDig(e.endereco.cep).length === 8 ? soDig(e.endereco.cep) : ''), el('UF', e.endereco.uf),
      el('fone', soDig(e.fone).length >= 7 ? soDig(e.fone).slice(0, 12) : '')));
  const v = d.veiculo;
  const prop = v.proprietario
    ? g('prop', doc(v.proprietario.documento), el('RNTRC', soDig(v.proprietario.rntrc).padStart(8, '0')), el('xNome', txt(v.proprietario.nome, 60)),
      soDig(v.proprietario.documento).length === 14 ? el('IE', soDig(v.proprietario.ie) || 'ISENTO') : '', el('UF', v.proprietario.uf), el('tpProp', v.proprietario.tpProp))
    : '';
  const rodo = g('rodo',
    g('infANTT', el('RNTRC', soDig(e.rntrc).padStart(8, '0')), d.ciot ? g('infCIOT', el('CIOT', soDig(d.ciot.numero)), doc(d.ciot.documento)) : ''),
    g('veicTracao', el('placa', v.placa), el('RENAVAM', v.renavam ? soDig(v.renavam) : ''), el('tara', Math.round(v.tara)), el('capKG', v.capKg ? Math.round(v.capKg) : ''), prop,
      g('condutor', el('xNome', txt(d.condutor.nome, 60)), el('CPF', soDig(d.condutor.cpf))), el('tpRod', v.tpRod), el('tpCar', v.tpCar), el('UF', v.uf)));
  const infDoc = g('infDoc', g('infMunDescarga', el('cMunDescarga', d.descarga.ibge), el('xMunDescarga', txt(d.descarga.municipio, 60)), ...d.chavesCte.map((c) => g('infCTe', el('chCTe', c)))));
  // carga lotação (um único CT-e): produto predominante com os CEPs de carregamento e descarga
  const lotacao = d.chavesCte.length === 1 && soDig(d.produto.cepCarrega).length === 8 && soDig(d.produto.cepDescarga).length === 8
    ? g('infLotacao', g('infLocalCarrega', el('CEP', soDig(d.produto.cepCarrega))), g('infLocalDescarrega', el('CEP', soDig(d.produto.cepDescarga)))) : '';
  const prodPred = g('prodPred', el('tpCarga', '05'), el('xProd', txt(d.produto.descricao || 'DIVERSOS', 120)), lotacao);
  const tot = g('tot', el('qCTe', d.chavesCte.length), el('vCarga', dec(d.totais.valorCarga)), el('cUnid', '01'), el('qCarga', dec(d.totais.pesoKg, 4)));
  const adic = d.observacao ? g('infAdic', el('infCpl', txt(d.observacao, 5000))) : '';
  const inf = `<infMDFe versao="${VERSAO_MDFE}" Id="MDFe${d.chave}">${ide}${emit}<infModal versaoModal="${VERSAO_MDFE}">${rodo}</infModal>${infDoc}${prodPred}${tot}${adic}</infMDFe>`;
  const supl = `<infMDFeSupl>${el('qrCodMDFe', `${d.qrCodeUrl}?chMDFe=${d.chave}&tpAmb=${d.tpAmb}`)}</infMDFeSupl>`;
  return `<MDFe xmlns="${NS_MDFE}">${inf}${supl}</MDFe>`;
}

export function montarEventoMdfe(p: { tpAmb: 1 | 2; cnpj: string; chave: string; tpEvento: string; nSeq: number; detalhe: string; dhEvento: string }) {
  const seq = String(p.nSeq).padStart(3, '0');
  return `<eventoMDFe xmlns="${NS_MDFE}" versao="${VERSAO_MDFE}"><infEvento Id="ID${p.tpEvento}${p.chave}${seq}">${el('cOrgao', p.chave.slice(0, 2))}${el('tpAmb', p.tpAmb)}${el('CNPJ', soDig(p.cnpj))}`
    + `${el('chMDFe', p.chave)}${el('dhEvento', p.dhEvento)}${el('tpEvento', p.tpEvento)}${el('nSeqEvento', p.nSeq)}<detEvento versaoEvento="${VERSAO_MDFE}">${p.detalhe}</detEvento></infEvento></eventoMDFe>`;
}
export const detalheEncerramento = (nProt: string, data: string, uf: string, ibge: string) =>
  `<evEncMDFe>${el('descEvento', 'Encerramento')}${el('nProt', nProt)}${el('dtEnc', data)}${el('cUF', UF_CODIGO[uf])}${el('cMun', ibge)}</evEncMDFe>`;
export const detalheCancelamentoMdfe = (nProt: string, just: string) =>
  `<evCancMDFe>${el('descEvento', 'Cancelamento')}${el('nProt', nProt)}${el('xJust', txt(just, 255))}</evCancMDFe>`;
