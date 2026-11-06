/** Remove pontuação mantendo letras (CNPJ alfanumérico a partir de 2026) e dígitos. */
export const limparDoc = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export const soDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export function cpfValido(cpf: string): boolean {
  const c = soDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}

/**
 * CNPJ numérico ou alfanumérico (IN RFB 2.229/2024): cada caractere vale (código ASCII − 48),
 * pesos 2..9 da direita para a esquerda, DV = 11 − (soma mod 11), resultando 0 quando ≥ 10.
 */
export function cnpjValido(cnpj: string): boolean {
  const c = limparDoc(cnpj);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (base: string) => {
    let soma = 0;
    let peso = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      soma += (base.charCodeAt(i) - 48) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const r = 11 - (soma % 11);
    return r >= 10 ? 0 : r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

export function documentoValido(doc: string): boolean {
  const c = limparDoc(doc);
  return c.length === 11 ? cpfValido(c) : c.length === 14 ? cnpjValido(c) : false;
}

export const codMunicipioValido = (c: string) => /^\d{7}$/.test(c);
export const cTribNacValido = (c: string) => /^\d{6}$/.test(soDigitos(c));
