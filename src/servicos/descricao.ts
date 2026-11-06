import { z } from 'zod';

/** Modelo de descrição composta de um cliente (ex.: mão de obra com INSS retido + aluguel de máquinas). */
export const DescricaoModelo = z.object({
  ativo: z.boolean().default(true),
  texto: z.string().trim().max(500).default('Prestação de serviços'),
  periodo: z.boolean().default(true),
  ordem_compra: z.boolean().default(true),
  /** % de retenção previdenciária (INSS) aplicado só às linhas marcadas com retem_cp. */
  cp_pct: z.number().min(0).max(100).default(11),
  linhas: z.array(z.object({ rotulo: z.string().trim().min(1).max(60), retem_cp: z.boolean().default(false) })).min(1).max(8),
});
export type DescricaoModelo = z.infer<typeof DescricaoModelo>;

export const EntradaDescricao = z.object({
  periodoIni: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  periodoFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  ordemCompra: z.string().trim().max(60).nullish(),
  /** valor de cada linha do modelo, na mesma ordem */
  valores: z.array(z.number().min(0).nullable()),
});

const brl = (n: number) => 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (d: string) => d.split('-').reverse().join('/');
const arred = (n: number) => Math.round(n * 100) / 100;

export function lerModelo(json: string | null | undefined): DescricaoModelo | null {
  if (!json) return null;
  try { const m = DescricaoModelo.parse(JSON.parse(json)); return m.ativo ? m : null; } catch { return null; }
}

/** Monta o texto da nota, o valor total e a retenção de INSS (só sobre as linhas marcadas). */
export function montarDescricao(modelo: DescricaoModelo, e: z.infer<typeof EntradaDescricao>) {
  const linhas = modelo.linhas.map((l, i) => ({ ...l, valor: arred(e.valores[i] ?? 0) }));
  const partes = [modelo.texto];
  if (modelo.periodo && e.periodoIni && e.periodoFim) {
    if (e.periodoFim < e.periodoIni) throw new Error('O período final é anterior ao inicial.');
    partes.push(`Período: ${dataBr(e.periodoIni)} a ${dataBr(e.periodoFim)}`);
  }
  if (modelo.ordem_compra && e.ordemCompra) partes.push(`Ordem de compra: ${e.ordemCompra}`);
  for (const l of linhas) if (l.valor > 0) partes.push(`${l.rotulo}: ${brl(l.valor)}`);
  const total = arred(linhas.reduce((a, l) => a + l.valor, 0));
  const baseCp = arred(linhas.filter((l) => l.retem_cp).reduce((a, l) => a + l.valor, 0));
  return { descricao: partes.join('\n'), valorTotal: total, baseCp, cp: arred((baseCp * modelo.cp_pct) / 100), cpPct: modelo.cp_pct };
}
