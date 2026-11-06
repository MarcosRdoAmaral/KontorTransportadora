import { db } from '../db.js';

/**
 * Lembretes do sininho do topo: só do que o usuário pode ver (módulos liberados e empresas a que tem acesso).
 * Tudo lido do que o Kontor já guarda.
 */
export interface Lembrete { nivel: 'ATENCAO' | 'PENDENTE' | 'INFO'; texto: string; link: string }

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const plural = (q: number, um: string, varios: string) => `${q} ${q === 1 ? um : varios}`;

export function lembretesDoUsuario(escritorioId: number, modulos: string[], empresas: number[] | null): Lembrete[] {
  const hoje = hojeBr();
  const filtro = empresas ? `AND e.id IN (${empresas.map(Number).join(',') || 'NULL'})` : '';
  const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  const l: Lembrete[] = [];
  const pode = (m: string) => modulos.includes(m);
  if (pode('cobrancas')) {
    const base = `FROM cobrancas c JOIN empresas e ON e.id = c.empresa_id WHERE e.escritorio_id = ? AND c.status NOT IN ('PAGO','CANCELADO','REJEITADO') ${filtro}`;
    const vencidas = n(`SELECT COUNT(*) AS n ${base} AND c.vencimento < ?`, escritorioId, hoje);
    const hojeV = n(`SELECT COUNT(*) AS n ${base} AND c.vencimento = ?`, escritorioId, hoje);
    if (vencidas) l.push({ nivel: 'ATENCAO', texto: `${plural(vencidas, 'cobrança vencida', 'cobranças vencidas')} sem pagamento.`, link: '#/cobrancas' });
    if (hojeV) l.push({ nivel: 'PENDENTE', texto: `${plural(hojeV, 'cobrança vence', 'cobranças vencem')} hoje.`, link: '#/cobrancas' });
  }
  if (pode('notas')) {
    const rej = n(`SELECT COUNT(*) AS n FROM notas x JOIN empresas e ON e.id = x.empresa_id WHERE e.escritorio_id = ? AND x.status IN ('REJEITADA','ERRO_COMUNICACAO') AND x.criado_em >= ? ${filtro}`, escritorioId, somaDias(hoje, -15));
    if (rej) l.push({ nivel: 'ATENCAO', texto: `${plural(rej, 'nota rejeitada ou com erro', 'notas rejeitadas ou com erro')} nos últimos 15 dias.`, link: '#/notas' });
  }
  if (pode('empresas') || pode('emitir')) {
    const cert = n(`SELECT COUNT(*) AS n FROM empresas e WHERE e.escritorio_id = ? AND e.cert_validade IS NOT NULL AND substr(e.cert_validade,1,10) <= ? ${filtro}`, escritorioId, somaDias(hoje, 30));
    if (cert) l.push({ nivel: 'PENDENTE', texto: `${plural(cert, 'certificado digital vencido ou vencendo', 'certificados digitais vencidos ou vencendo')} em até 30 dias.`, link: '#/empresas' });
  }
  const ordem = { ATENCAO: 0, PENDENTE: 1, INFO: 2 };
  return l.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}
