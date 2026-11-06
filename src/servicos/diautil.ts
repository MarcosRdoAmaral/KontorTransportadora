/** Dias úteis para o vencimento do boleto: sábado, domingo e feriados nacionais (e os locais cadastrados na empresa). */
const DIA = 864e5;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function pascoa(ano: number): number {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}

/** Feriados do ano: nacionais fixos, carnaval (seg/ter), sexta-feira santa, Corpus Christi e os locais ("24/06, 19/03"). */
export function feriados(ano: number, extras?: string | null): Set<string> {
  const s = new Set<string>();
  ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].forEach((x) => s.add(`${ano}-${x}`));
  const p = pascoa(ano);
  [-48, -47, -2, 60].forEach((n) => s.add(iso(p + n * DIA)));
  for (const t of (extras ?? '').split(/[,;\s]+/)) {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
    if (m) s.add(`${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  }
  return s;
}

/** Por que a data não é dia útil ('' se for). */
export function motivoNaoUtil(data: string, extras?: string | null): '' | 'sábado' | 'domingo' | 'feriado' {
  const [y, m, d] = data.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 'domingo' : w === 6 ? 'sábado' : feriados(y, extras).has(data) ? 'feriado' : '';
}

function passo(data: string, sentido: 1 | -1, extras?: string | null): string {
  let t = Date.parse(data + 'T00:00:00Z');
  for (let i = 0; i < 15 && motivoNaoUtil(iso(t), extras); i++) t += sentido * DIA;
  return iso(t);
}

/**
 * Vencimento em dia útil: antecipa para o dia útil anterior; se isso cair antes de hoje,
 * usa o próximo dia útil (o boleto não pode nascer vencido).
 */
export function ajustarVencimento(venc: string, hoje: string, extras?: string | null): { data: string; aviso?: string } {
  const motivo = motivoNaoUtil(venc, extras);
  if (!motivo) return { data: venc };
  let novo = passo(venc, -1, extras);
  if (novo < hoje) novo = passo(venc, 1, extras);
  const br = (d: string) => d.split('-').reverse().join('/');
  return { data: novo, aviso: `Vencimento ajustado: ${br(venc)} cai em ${motivo === 'feriado' ? 'feriado' : motivo}; ${novo < venc ? 'antecipado' : 'adiado'} para ${br(novo)}.` };
}
