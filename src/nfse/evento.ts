import { NS_NFSE } from './dps.js';
import { t, texto } from './xml.js';
import { limparDoc } from './validacao.js';

export const MOTIVOS_CANCELAMENTO = {
  1: 'Erro na emissão',
  2: 'Serviço não prestado',
  9: 'Outros',
} as const;

/**
 * Pedido de registro do evento de cancelamento (e101101), leiaute 1.01.
 * Id = "PRE" + chave de acesso (50) + código do evento (6) — 59 posições.
 */
export function montarCancelamento(p: {
  tpAmb: 1 | 2;
  verAplic: string;
  dhEvento: string;
  documentoAutor: string;
  chNFSe: string;
  cMotivo: 1 | 2 | 9;
  xMotivo: string;
}): string {
  const doc = limparDoc(p.documentoAutor);
  const id = `PRE${p.chNFSe}101101`;
  return (
    `<pedRegEvento xmlns="${NS_NFSE}" versao="1.01"><infPedReg Id="${id}">` +
    t('tpAmb', p.tpAmb) +
    t('verAplic', p.verAplic) +
    t('dhEvento', p.dhEvento) +
    (doc.length === 11 ? t('CPFAutor', doc) : t('CNPJAutor', doc)) +
    t('chNFSe', p.chNFSe) +
    `<e101101>${t('xDesc', 'Cancelamento de NFS-e')}${t('cMotivo', p.cMotivo)}${t('xMotivo', texto(p.xMotivo, 255))}</e101101>` +
    `</infPedReg></pedRegEvento>`
  );
}
