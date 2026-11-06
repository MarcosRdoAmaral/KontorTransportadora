import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false, // mantém zeros à esquerda (CNPJ, CEP, códigos)
  trimValues: true,
});

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** Grupo IBS/CBS: o que foi declarado na DPS + os valores apurados pelo sistema nacional (infNFSe/IBSCBS). */
function lerIbsCbs(d: any, n: any) {
  if (!d && !n) return undefined;
  // NT 009: CST/cClassTrib ficam direto em trib; no leiaute anterior, dentro de gIBSCBS
  const tr = d?.valores?.trib ?? {};
  const g = tr.CST !== undefined ? tr : tr.gIBSCBS ?? {};
  const v = n?.valores ?? {};
  const tot = n?.totCIBS ?? {};
  return {
    cIndOp: d?.cIndOp as string | undefined,
    cst: g.CST as string | undefined,
    cClassTrib: g.cClassTrib as string | undefined,
    cLocIncid: n?.cLocalidadeIncid as string | undefined,
    xLocIncid: n?.xLocalidadeIncid as string | undefined,
    pRedutor: num(n?.pRedutor),
    vBC: num(v.vBC),
    pIBSUF: num(v.uf?.pIBSUF), pRedAliqUF: num(v.uf?.pRedAliqUF), pAliqEfetUF: num(v.uf?.pAliqEfetUF),
    pIBSMun: num(v.mun?.pIBSMun), pRedAliqMun: num(v.mun?.pRedAliqMun), pAliqEfetMun: num(v.mun?.pAliqEfetMun),
    pCBS: num(v.fed?.pCBS), pRedAliqCBS: num(v.fed?.pRedAliqCBS), pAliqEfetCBS: num(v.fed?.pAliqEfetCBS),
    vIBSUF: num(tot.gIBS?.gIBSUFTot?.vIBSUF),
    vIBSMun: num(tot.gIBS?.gIBSMunTot?.vIBSMun),
    vIBSTot: num(tot.gIBS?.vIBSTot),
    vCBS: num(tot.gCBS?.vCBS),
    vTotNF: num(tot.vTotNF),
  };
}

/** Extrai do XML da NFS-e autorizada os campos usados no sistema e no DANFSe. */
export function lerNfse(xml: string) {
  const raiz = parser.parse(xml);
  const inf = raiz?.NFSe?.infNFSe;
  if (!inf) throw new Error('XML não contém uma NFS-e (infNFSe ausente).');
  const dps = inf.DPS?.infDPS ?? {};
  const prest = dps.prest ?? {};
  const toma = dps.toma;
  const serv = dps.serv ?? {};
  const vDps = dps.valores ?? {};
  const tribMun = vDps.trib?.tribMun ?? {};
  const tribFed = vDps.trib?.tribFed ?? {};
  const totTrib = vDps.trib?.totTrib ?? {};
  const emit = inf.emit ?? {};
  const vNf = inf.valores ?? {};

  return {
    chave: String(inf['@Id'] ?? '').replace(/^NFS/, ''),
    numero: inf.nNFSe as string,
    nDFSe: inf.nDFSe as string,
    ambGer: inf.ambGer as string,
    tpAmb: Number(dps.tpAmb),
    cStat: inf.cStat as string,
    dhProc: inf.dhProc as string,
    xLocEmi: inf.xLocEmi as string,
    xLocPrestacao: inf.xLocPrestacao as string,
    xLocIncid: inf.xLocIncid as string | undefined,
    xTribNac: inf.xTribNac as string,
    xTribMun: inf.xTribMun as string | undefined,
    xNBS: inf.xNBS as string | undefined,
    xOutInf: inf.xOutInf as string | undefined,
    dps: {
      id: dps['@Id'] as string,
      serie: dps.serie as string,
      nDPS: dps.nDPS as string,
      dhEmi: dps.dhEmi as string,
      dCompet: dps.dCompet as string,
      opSimpNac: prest.regTrib?.opSimpNac as string,
      regEspTrib: prest.regTrib?.regEspTrib as string,
      regApTribSN: prest.regTrib?.regApTribSN as string | undefined,
      tpEmit: dps.tpEmit as string | undefined,
      // NT 009 moveu finNFSe para infDPS; notas antigas o trazem dentro de IBSCBS
      finNFSe: (dps.finNFSe ?? dps.IBSCBS?.finNFSe) as string | undefined,
    },
    ibscbs: lerIbsCbs(dps.IBSCBS, inf.IBSCBS),
    emitente: {
      documento: (emit.CNPJ ?? emit.CPF) as string,
      im: emit.IM as string | undefined,
      nome: emit.xNome as string,
      fantasia: emit.xFant as string | undefined,
      fone: emit.fone as string | undefined,
      email: emit.email as string | undefined,
      end: emit.enderNac as { xLgr: string; nro: string; xCpl?: string; xBairro: string; cMun: string; UF: string; CEP: string } | undefined,
    },
    tomador: toma
      ? {
          documento: (toma.CNPJ ?? toma.CPF ?? toma.NIF) as string | undefined,
          im: toma.IM as string | undefined,
          nome: toma.xNome as string,
          fone: toma.fone as string | undefined,
          email: toma.email as string | undefined,
          end: toma.end
            ? { xLgr: toma.end.xLgr, nro: toma.end.nro, xCpl: toma.end.xCpl, xBairro: toma.end.xBairro, cMun: toma.end.endNac?.cMun, CEP: toma.end.endNac?.CEP }
            : undefined,
        }
      : undefined,
    servico: {
      cTribNac: serv.cServ?.cTribNac as string,
      cTribMun: serv.cServ?.cTribMun as string | undefined,
      cNBS: serv.cServ?.cNBS as string | undefined,
      descricao: serv.cServ?.xDescServ as string,
      infoCompl: serv.infoCompl?.xInfComp as string | undefined,
    },
    valores: {
      vServ: num(vDps.vServPrest?.vServ) ?? 0,
      vDescIncond: num(vDps.vDescCondIncond?.vDescIncond),
      vDescCond: num(vDps.vDescCondIncond?.vDescCond),
      tribISSQN: tribMun.tribISSQN as string,
      tpRetISSQN: tribMun.tpRetISSQN as string,
      pAliq: num(vNf.pAliqAplic ?? tribMun.pAliq),
      vBC: num(vNf.vBC),
      vISSQN: num(vNf.vISSQN),
      vTotalRet: num(vNf.vTotalRet),
      vLiq: num(vNf.vLiq) ?? 0,
      vRetIRRF: num(tribFed.vRetIRRF),
      vRetCP: num(tribFed.vRetCP),
      vRetCSLL: num(tribFed.vRetCSLL),
      vPis: num(tribFed.piscofins?.vPis),
      vCofins: num(tribFed.piscofins?.vCofins),
      tpRetPisCofins: tribFed.piscofins?.tpRetPisCofins as string | undefined,
      pTotTribSN: num(totTrib.pTotTribSN),
      pTotTrib: totTrib.pTotTrib
        ? { fed: num(totTrib.pTotTrib.pTotTribFed), est: num(totTrib.pTotTrib.pTotTribEst), mun: num(totTrib.pTotTrib.pTotTribMun) }
        : undefined,
    },
  };
}

export type NfseLida = ReturnType<typeof lerNfse>;
