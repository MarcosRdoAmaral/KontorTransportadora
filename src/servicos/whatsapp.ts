import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { codigoDeLicenca } from '../licenca.js';

/** Serviço da Kontor que guarda as credenciais do Twilio (ferramentas/relay-whatsapp). */
export const RELAY_PADRAO = 'https://wa.kontorgestao.com.br';
export const relayUrl = () => (process.env.WHATSAPP_RELAY_URL || RELAY_PADRAO).replace(/\/+$/, '');

export const TIPOS_WHATSAPP = ['lembrete', 'atraso', 'nota', 'pagamento'] as const;
export type TipoWhatsapp = (typeof TIPOS_WHATSAPP)[number];
export const NOME_TIPO: Record<TipoWhatsapp, string> = { lembrete: 'Lembrete de vencimento', atraso: 'Cobrança em atraso', nota: 'Nota emitida', pagamento: 'Pagamento confirmado' };

export const PedidoWhatsapp = z.object({
  tipo: z.enum(TIPOS_WHATSAPP),
  fone: z.string().min(8, 'Informe o WhatsApp do cliente'),
  /** Variáveis posicionais do template aprovado: { "1": "Maria", "2": "R$ 100,00" ... } */
  variaveis: z.record(z.string(), z.string().max(600)).default({}),
  /** Texto livre usado quando o template ainda não foi aprovado (sandbox / janela de 24 h). */
  texto: z.string().max(1500).nullish(),
  tomadorId: z.number().int().positive().nullish(),
  cobrancaId: z.number().int().positive().nullish(),
  notaId: z.number().int().positive().nullish(),
  /** O operador confirma que o cliente autorizou receber mensagens por WhatsApp. */
  aceite: z.boolean().optional(),
});
export type PedidoWhatsapp = z.infer<typeof PedidoWhatsapp>;

/** Normaliza para 55 + DDD + número (10 ou 11 dígitos), ou lança ErroNegocio. */
export function normalizarFone(fone: string): string {
  let n = fone.replace(/\D/g, '').replace(/^0+/, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  if (!/^55\d{10,11}$/.test(n)) throw new ErroNegocio('Número inválido. Informe DDD + número, por exemplo (47) 99999-9999.');
  return n;
}

/** Permite trocar a chamada de rede nos testes. */
let chamar: typeof fetch = (...a) => fetch(...a);
export function trocarRede(f: typeof fetch) { chamar = f; }

export interface Envio {
  id: number; empresa_id: number; tipo: TipoWhatsapp; destino: string; status: string; erro: string | null;
  tomador_id: number | null; cobranca_id: number | null; nota_id: number | null; criado_em: string;
}

export async function enviarWhatsapp(empresaId: number, usuarioId: number | null, p: PedidoWhatsapp): Promise<{ ok: true; status: string; restante: number | null; id: number }> {
  const destino = normalizarFone(p.fone);
  if (p.tomadorId) {
    const t = db.prepare('SELECT whatsapp_aceite FROM tomadores WHERE id = ? AND empresa_id = ?').get(p.tomadorId, empresaId) as { whatsapp_aceite: number } | undefined;
    if (!t) throw new ErroNegocio('Cliente não encontrado.');
    if (!t.whatsapp_aceite && !p.aceite) throw new ErroNegocio('Confirme que o cliente autorizou receber mensagens por WhatsApp.');
  } else if (!p.aceite) throw new ErroNegocio('Confirme que o cliente autorizou receber mensagens por WhatsApp.');

  const licenca = codigoDeLicenca();
  if (!licenca) throw new ErroNegocio('O envio automático de WhatsApp exige o sistema ativado. Ative a licença em Configurações > Licença.');

  const registrar = (status: string, erro: string | null, sid: string | null) =>
    Number(db.prepare(`INSERT INTO whatsapp_envios (empresa_id, tipo, destino, status, erro, sid, tomador_id, cobranca_id, nota_id, usuario_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(empresaId, p.tipo, destino, status, erro, sid, p.tomadorId ?? null, p.cobrancaId ?? null, p.notaId ?? null, usuarioId).lastInsertRowid);

  let resp: Response;
  try {
    resp = await chamar(`${relayUrl()}/enviar`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ licenca, produto: 'empresas', tipo: p.tipo, para: destino, variaveis: p.variaveis, texto: p.texto ?? undefined }),
    });
  } catch {
    registrar('FALHA', 'Sem conexão com o serviço de WhatsApp.', null);
    throw new ErroNegocio('Não foi possível falar com o serviço de WhatsApp. Verifique a internet e tente de novo.');
  }
  const d = (await resp.json().catch(() => ({}))) as { ok?: boolean; erro?: string; sid?: string; status?: string; restante?: number };
  if (!resp.ok || !d.ok) {
    const msg = d.erro || 'O serviço de WhatsApp recusou o envio.';
    registrar('FALHA', msg, null);
    throw new ErroNegocio(msg);
  }
  if (p.tomadorId && p.aceite) db.prepare('UPDATE tomadores SET whatsapp_aceite = 1 WHERE id = ?').run(p.tomadorId); // o aceite só é guardado quando o envio deu certo
  const id = registrar(d.status || 'ENFILEIRADA', null, d.sid ?? null);
  return { ok: true, status: d.status || 'enfileirada', restante: d.restante ?? null, id };
}

export function historicoWhatsapp(empresaId: number, limite = 100) {
  return db.prepare(`SELECT w.id, w.tipo, w.destino, w.status, w.erro, w.criado_em, w.cobranca_id, w.nota_id, t.nome AS cliente
      FROM whatsapp_envios w LEFT JOIN tomadores t ON t.id = w.tomador_id WHERE w.empresa_id = ? ORDER BY w.id DESC LIMIT ?`).all(empresaId, limite);
}
