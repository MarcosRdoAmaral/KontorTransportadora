import { dec, g, t, texto } from './xml.js';
import { limparDoc, soDigitos } from './validacao.js';

export const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO_DPS = '1.01';

/**
 * Leiaute da DPS.
 * - 'nt004': leiaute vigente em produção até 30/11/2026 (NT 004 + tpRetPisCofins da NT 007), XSDs em schemas/1.01.
 * - 'nt009': release 1 da NT 009 (produção restrita desde 20/10/2026; produção em 01/12/2026), XSDs em schemas/nt009-r1.
 */
export type LeiauteDps = 'nt004' | 'nt009';
export const PRODUCAO_NT009 = '2026-12-01';

/** Produção restrita já usa a NT 009; produção passa a usá-la a partir de 01/12/2026 (data de emissão). */
export function leiauteVigente(tpAmb: 1 | 2, dhEmi: string): LeiauteDps {
  return tpAmb === 2 || dhEmi.slice(0, 10) >= PRODUCAO_NT009 ? 'nt009' : 'nt004';
}

export interface Endereco {
  cMun: string;      // IBGE 7 dígitos
  cep: string;
  xLgr: string;
  nro: string;
  xCpl?: string;
  xBairro: string;
}

export interface DadosDPS {
  /** Força um leiaute; se omitido, usa leiauteVigente(tpAmb, dhEmi). */
  leiaute?: LeiauteDps;
  tpAmb: 1 | 2;
  dhEmi: string;
  verAplic: string;
  serie: string;
  nDPS: number;
  dCompet: string;   // AAAA-MM-DD
  cLocEmi: string;
  prestador: {
    documento: string;
    im?: string;
    fone?: string;
    email?: string;
    opSimpNac: 1 | 2 | 3;
    regApTribSN?: 1 | 2 | 3;
    regEspTrib: number;
  };
  tomador?: {
    documento?: string;
    nome: string;
    im?: string;
    end?: Endereco;
    fone?: string;
    email?: string;
  };
  servico: {
    cLocPrestacao: string;
    cTribNac: string;
    cTribMun?: string;
    xDescServ: string;
    cNBS?: string;
    xInfComp?: string;
  };
  valores: {
    vServ: number;
    vDescIncond?: number;
    vDescCond?: number;
    /** 1 Tributável, 2 Imunidade, 3 Exportação, 4 Não incidência */
    tribISSQN: 1 | 2 | 3 | 4;
    tpImunidade?: number;
    cPaisResult?: string;
    /** 1 Não retido, 2 Retido pelo tomador, 3 Retido pelo intermediário */
    tpRetISSQN: 1 | 2 | 3;
    pAliq?: number;
    vRetCP?: number;
    vRetIRRF?: number;
    vRetCSLL?: number;
    /** PIS/COFINS (grupo piscofins de tribFed): informado quando há retenção federal. */
    pisCofins?: { cst: string; base?: number; pPis?: number; pCofins?: number; vPis?: number; vCofins?: number; tpRet: number };
    /** % aproximado de tributos — Simples Nacional (ME/EPP) */
    pTotTribSN?: number;
    /** % aproximado de tributos — demais regimes */
    pTotTrib?: { fed: number; est: number; mun: number };
  };
  /** Grupo IBS/CBS (Reforma Tributária). Obrigatório para o regime regular. */
  ibscbs?: {
    finNFSe?: 0;
    indFinal: 0 | 1;
    cIndOp: string;
    indDest: 0 | 1;
    cst: string;
    cClassTrib: string;
  };
}

function pisCofinsXml(p: NonNullable<DadosDPS['valores']['pisCofins']> | undefined): string {
  if (!p) return '';
  return g('piscofins', t('CST', p.cst), t('vBCPisCofins', dec(p.base)), t('pAliqPis', dec(p.pPis)), t('pAliqCofins', dec(p.pCofins)),
    t('vPis', dec(p.vPis)), t('vCofins', dec(p.vCofins)), t('tpRetPisCofins', p.tpRet));
}

/** "DPS" + cMun(7) + tipo inscrição(1: 1=CPF, 2=CNPJ) + inscrição(14) + série(5) + número(15) = 45 posições */
export function gerarIdDps(cLocEmi: string, documentoPrestador: string, serie: string, nDPS: number): string {
  const doc = limparDoc(documentoPrestador);
  const tipo = doc.length === 11 ? '1' : '2';
  return `DPS${cLocEmi}${tipo}${doc.padStart(14, '0')}${soDigitos(serie).padStart(5, '0')}${String(nDPS).padStart(15, '0')}`;
}

/** Identificação de pessoa: CNPJ ou CPF conforme o tamanho do documento. */
function docPessoa(documento?: string): string {
  const d = limparDoc(documento);
  if (!d) return '';
  return d.length === 11 ? t('CPF', d) : t('CNPJ', d);
}

function endereco(e?: Endereco): string {
  if (!e) return '';
  return g(
    'end',
    g('endNac', t('cMun', e.cMun), t('CEP', soDigitos(e.cep))),
    t('xLgr', texto(e.xLgr, 255)),
    t('nro', texto(e.nro, 60)),
    t('xCpl', texto(e.xCpl, 156)),
    t('xBairro', texto(e.xBairro, 60)),
  );
}

/**
 * Monta o XML da DPS (leiaute 1.01) na ordem exata do xs:sequence do XSD oficial.
 * Retorna o XML sem assinatura; a assinatura é aplicada em seguida sobre infDPS.
 */
export function montarDps(d: DadosDPS): { xml: string; id: string; leiaute: LeiauteDps } {
  const leiaute = d.leiaute ?? leiauteVigente(d.tpAmb, d.dhEmi);
  const nt009 = leiaute === 'nt009';
  const id = gerarIdDps(d.cLocEmi, d.prestador.documento, d.serie, d.nDPS);
  const p = d.prestador;
  const v = d.valores;

  // Quando o emitente é o próprio prestador (tpEmit=1), nome e endereço NÃO são informados:
  // a Sefin usa o Cadastro Nacional (informá-los gera rejeição).
  const prest = g(
    'prest',
    docPessoa(p.documento),
    t('IM', p.im),
    t('fone', soDigitos(p.fone) || undefined),
    t('email', p.email),
    g('regTrib', t('opSimpNac', p.opSimpNac), p.opSimpNac === 3 ? t('regApTribSN', p.regApTribSN ?? 1) : '', t('regEspTrib', p.regEspTrib)),
  );

  const toma = d.tomador
    ? g(
        'toma',
        docPessoa(d.tomador.documento),
        t('IM', d.tomador.im),
        t('xNome', texto(d.tomador.nome, 300)),
        endereco(d.tomador.end),
        t('fone', soDigitos(d.tomador.fone) || undefined),
        t('email', d.tomador.email),
      )
    : '';

  const serv = g(
    'serv',
    g('locPrest', t('cLocPrestacao', d.servico.cLocPrestacao)),
    g(
      'cServ',
      t('cTribNac', soDigitos(d.servico.cTribNac)),
      t('cTribMun', d.servico.cTribMun),
      // NT 009: cNBS passa a vir antes de xDescServ
      nt009 ? t('cNBS', soDigitos(d.servico.cNBS) || undefined) : '',
      t('xDescServ', texto(d.servico.xDescServ, 2000)),
      nt009 ? '' : t('cNBS', soDigitos(d.servico.cNBS) || undefined),
    ),
    d.servico.xInfComp ? g('infoCompl', t('xInfComp', texto(d.servico.xInfComp, 2000))) : '',
  );

  let totTrib: string;
  if (v.pTotTribSN !== undefined && v.pTotTribSN !== null) totTrib = t('pTotTribSN', dec(v.pTotTribSN));
  // E0713: não optante do Simples não pode usar indTotTrib nem pTotTribSN; informa o percentual aproximado (Lei 12.741)
  else if (d.prestador.opSimpNac === 1) totTrib = g('pTotTrib', t('pTotTribFed', dec(v.pTotTrib?.fed ?? 0)), t('pTotTribEst', dec(v.pTotTrib?.est ?? 0)), t('pTotTribMun', dec(v.pTotTrib?.mun ?? 0)));
  else if (v.pTotTrib) totTrib = g('pTotTrib', t('pTotTribFed', dec(v.pTotTrib.fed)), t('pTotTribEst', dec(v.pTotTrib.est)), t('pTotTribMun', dec(v.pTotTrib.mun)));
  else totTrib = t('indTotTrib', 0);

  const valores = g(
    'valores',
    g('vServPrest', t('vServ', dec(v.vServ))),
    v.vDescIncond || v.vDescCond ? g('vDescCondIncond', t('vDescIncond', dec(v.vDescIncond || undefined)), t('vDescCond', dec(v.vDescCond || undefined))) : '',
    g(
      'trib',
      g(
        'tribMun',
        t('tribISSQN', v.tribISSQN),
        v.tribISSQN === 3 ? t('cPaisResult', v.cPaisResult) : '',
        v.tribISSQN === 2 ? t('tpImunidade', v.tpImunidade) : '',
        t('tpRetISSQN', v.tpRetISSQN),
        v.tribISSQN === 1 ? t('pAliq', dec(v.pAliq)) : '',
      ),
      g('tribFed', pisCofinsXml(v.pisCofins), t('vRetCP', dec(v.vRetCP || undefined)), t('vRetIRRF', dec(v.vRetIRRF || undefined)), t('vRetCSLL', dec(v.vRetCSLL || undefined))),
      g('totTrib', totTrib),
    ),
  );

  const ib = d.ibscbs;
  const ibscbs = !ib
    ? ''
    : nt009
      ? g(
          'IBSCBS',
          t('indFinal', ib.indFinal),
          t('cIndOp', ib.cIndOp),
          t('indDest', ib.indDest),
          // NT 009 item 2.16: CST e cClassTrib direto em trib
          g('valores', g('trib', t('CST', ib.cst), t('cClassTrib', ib.cClassTrib))),
        )
      : g(
          'IBSCBS',
          t('finNFSe', ib.finNFSe ?? 0),
          t('indFinal', ib.indFinal),
          t('cIndOp', ib.cIndOp),
          t('indDest', ib.indDest),
          g('valores', g('trib', g('gIBSCBS', t('CST', ib.cst), t('cClassTrib', ib.cClassTrib)))),
        );

  const inf =
    `<infDPS Id="${id}">` +
    t('tpAmb', d.tpAmb) +
    t('dhEmi', d.dhEmi) +
    t('verAplic', d.verAplic) +
    t('serie', soDigitos(d.serie)) +
    t('nDPS', d.nDPS) +
    t('dCompet', d.dCompet) +
    t('tpEmit', 1) +
    // NT 009: finNFSe obrigatório em infDPS (0 = NFS-e regular)
    (nt009 ? t('finNFSe', ib?.finNFSe ?? 0) : '') +
    t('cLocEmi', d.cLocEmi) +
    prest +
    toma +
    serv +
    valores +
    ibscbs +
    `</infDPS>`;

  return { id, leiaute, xml: `<DPS xmlns="${NS_NFSE}" versao="${VERSAO_DPS}">${inf}</DPS>` };
}
