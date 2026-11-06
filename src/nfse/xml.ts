/**
 * Montagem de XML por string, determinística e sem espaços entre tags
 * (a Sefin rejeita assinatura quando há formatação/whitespace divergente).
 * Elementos com valor undefined/null/'' são omitidos — assim campos opcionais
 * do XSD simplesmente não aparecem.
 */
/** A Sefin exige a declaração XML com UTF-8 no início do documento (senão rejeita com E1229). */
export const DECLARACAO_XML = '<?xml version="1.0" encoding="UTF-8"?>';

export type No = string | undefined | null | false;

export function esc(v: string | number): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Elemento com texto. Omite se valor vazio. */
export function t(nome: string, valor: string | number | undefined | null): string {
  if (valor === undefined || valor === null || valor === '') return '';
  return `<${nome}>${esc(valor)}</${nome}>`;
}

/** Elemento com filhos. Omite se todos os filhos forem vazios. */
export function g(nome: string, ...filhos: No[]): string {
  const conteudo = filhos.filter(Boolean).join('');
  return conteudo ? `<${nome}>${conteudo}</${nome}>` : '';
}

/** Valor monetário/percentual com 2 casas e ponto decimal (TSDec15V2 / TSDec2V2). */
export const dec = (n: number | undefined | null, casas = 2) =>
  n === undefined || n === null || Number.isNaN(n) ? undefined : (Math.round(n * 10 ** casas) / 10 ** casas).toFixed(casas);

/** Remove caracteres de controle e normaliza espaços, evitando rejeição por texto inválido. */
export const texto = (s: string | undefined | null, max?: number) => {
  if (!s) return undefined;
  const limpo = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  return max ? limpo.slice(0, max) : limpo;
};

/** Data/hora no formato AAAA-MM-DDThh:mm:ss-03:00 (horário de Brasília). */
export function dataHoraBrasilia(d = new Date()): string {
  const local = new Date(d.getTime() - 3 * 3600 * 1000);
  return local.toISOString().slice(0, 19) + '-03:00';
}
