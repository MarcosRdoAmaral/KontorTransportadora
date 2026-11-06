import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true,
  isArray: (nome) => ['det', 'dup', 'detPag'].includes(nome),
});
const n = (v: unknown) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
const txt = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

export interface ItemNfe { n: number; codigo: string | null; descricao: string; ncm: string | null; cfop: string | null; unidade: string | null; quantidade: number; valorUnit: number; valor: number; desconto: number }
export interface NfeLida {
  chave: string; numero: string; serie: string; modelo: string; emissao: string; natureza: string | null;
  fornecedor: { documento: string; nome: string; fantasia: string | null; uf: string | null; municipio: string | null };
  destinatario: { documento: string | null; nome: string | null };
  totais: { produtos: number; frete: number; seguro: number; desconto: number; outras: number; icms: number; icmsSt: number; ipi: number; nf: number; ibsUf: number; ibsMun: number; cbs: number };
  itens: ItemNfe[];
  parcelas: { numero: string | null; vencimento: string; valor: number }[];
  pagamentos: { tPag: string; valor: number }[];
}

/** Lê o XML de uma NF-e (modelo 55) ou NFC-e (65): com protocolo (nfeProc) ou só a NFe assinada. */
export function lerNfe(xml: string): NfeLida {
  let raiz: any;
  try { raiz = parser.parse(xml); } catch { throw new Error('O arquivo não é um XML válido.'); }
  const nfe = raiz?.nfeProc?.NFe ?? raiz?.NFe ?? raiz?.procNFe?.NFe;
  if (!nfe?.infNFe) {
    if (raiz?.CompNfse || raiz?.NFSe || raiz?.nfseProc) throw new Error('Este XML é de NFS-e (serviço). Em Compras só entram NF-e de mercadorias; notas de serviço ficam em Notas emitidas.');
    if (raiz?.procEventoNFe || raiz?.evento) throw new Error('Este XML é de um evento (cancelamento/carta de correção), não da nota. Use o XML da NF-e.');
    throw new Error('Não encontrei uma NF-e neste XML.');
  }
  const inf = nfe.infNFe, ide = inf.ide ?? {}, emit = inf.emit ?? {}, dest = inf.dest ?? {}, tot = inf.total?.ICMSTot ?? {};
  const chave = String(raiz?.nfeProc?.protNFe?.infProt?.chNFe ?? inf['@Id'] ?? '').replace(/\D/g, '');
  if (chave.length !== 44) throw new Error('Não encontrei a chave de acesso de 44 dígitos na NF-e.');
  const emissao = String(ide.dhEmi ?? ide.dEmi ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emissao)) throw new Error('Data de emissão ausente ou inválida na NF-e.');
  const itens: ItemNfe[] = (inf.det ?? []).map((d: any) => ({
    n: Number(d['@nItem']) || 0, codigo: txt(d.prod?.cProd), descricao: String(d.prod?.xProd ?? ''), ncm: txt(d.prod?.NCM), cfop: txt(d.prod?.CFOP),
    unidade: txt(d.prod?.uCom), quantidade: n(d.prod?.qCom), valorUnit: n(d.prod?.vUnCom), valor: n(d.prod?.vProd), desconto: n(d.prod?.vDesc),
  }));
  const parcelas = (inf.cobr?.dup ?? []).map((p: any) => ({ numero: txt(p.nDup), vencimento: String(p.dVenc ?? '').slice(0, 10), valor: n(p.vDup) }))
    .filter((p: any) => /^\d{4}-\d{2}-\d{2}$/.test(p.vencimento) && p.valor > 0);
  const detPag = inf.pag?.detPag ?? [];
  return {
    chave, numero: String(ide.nNF ?? ''), serie: String(ide.serie ?? ''), modelo: String(ide.mod ?? '55'), emissao, natureza: txt(ide.natOp),
    fornecedor: { documento: String(emit.CNPJ ?? emit.CPF ?? ''), nome: String(emit.xNome ?? ''), fantasia: txt(emit.xFant), uf: txt(emit.enderEmit?.UF), municipio: txt(emit.enderEmit?.xMun) },
    destinatario: { documento: txt(dest.CNPJ ?? dest.CPF), nome: txt(dest.xNome) },
    totais: { produtos: n(tot.vProd), frete: n(tot.vFrete), seguro: n(tot.vSeg), desconto: n(tot.vDesc), outras: n(tot.vOutro), icms: n(tot.vICMS), icmsSt: n(tot.vST), ipi: n(tot.vIPI), nf: n(tot.vNF),
      ibsUf: n(inf.total?.IBSCBSTot?.gIBS?.gIBSUF?.vIBSUF), ibsMun: n(inf.total?.IBSCBSTot?.gIBS?.gIBSMun?.vIBSMun), cbs: n(inf.total?.IBSCBSTot?.gCBS?.vCBS) },
    itens, parcelas, pagamentos: detPag.map((p: any) => ({ tPag: String(p.tPag ?? ''), valor: n(p.vPag) })),
  };
}
