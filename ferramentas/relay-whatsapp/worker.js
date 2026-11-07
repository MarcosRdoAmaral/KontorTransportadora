/**
 * Relay de WhatsApp da Kontor (Cloudflare Worker).
 *
 * O programa instalado no cliente NÃO guarda as credenciais do Twilio: ele pede o envio a este serviço,
 * que confere a licença (assinatura Ed25519), aplica a cota e chama o Twilio.
 *
 * Segredos (wrangler secret put ...):  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 * Variáveis (wrangler.toml [vars]):    TWILIO_WHATSAPP_FROM (ex.: +5547999999999), CHAVE_PUBLICA, COTA_MENSAL,
 *                                      CONTENT_SID_LEMBRETE / _ATRASO / _NOTA / _PAGAMENTO (templates aprovados; vazio = texto livre)
 * KV:                                  COTAS (contadores por computador e por mês)
 */
const TIPOS = ['lembrete', 'atraso', 'nota', 'pagamento'];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/** Confere a assinatura do código de licença (KG1/KG2/KG3) e devolve { maquina, ate, cliente }. */
export async function lerLicenca(codigo, chavePublica) {
  const partes = String(codigo ?? '').trim().split('.');
  if (partes.length !== 3 || !['KG1', 'KG2', 'KG3'].includes(partes[0])) throw new Erro(401, 'Licença inválida.');
  let ok = false;
  try {
    const chave = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: chavePublica }, { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, chave, b64u(partes[2]), b64u(partes[1]));
  } catch { ok = false; }
  if (!ok) throw new Erro(401, 'Licença inválida.');
  const campos = new TextDecoder().decode(b64u(partes[1])).split('|');
  const [maquina, ate] = campos;
  if (!maquina || !/^\d{4}-\d{2}-\d{2}$/.test(ate ?? '')) throw new Erro(401, 'Licença inválida.');
  const cliente = partes[0] === 'KG1' ? campos.slice(2).join('|') : partes[0] === 'KG2' ? campos.slice(3).join('|') : campos.slice(4).join('|');
  return { maquina, ate, cliente };
}

class Erro extends Error { constructor(status, mensagem) { super(mensagem); this.status = status; } }

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

function validarPedido(d) {
  if (!TIPOS.includes(d?.tipo)) throw new Erro(400, 'Tipo de mensagem inválido.');
  if (!/^55\d{10,11}$/.test(String(d?.para ?? ''))) throw new Erro(400, 'Número de destino inválido (use 55 + DDD + número).');
  if (d.variaveis != null && (typeof d.variaveis !== 'object' || Object.values(d.variaveis).some((v) => typeof v !== 'string' || v.length > 600))) throw new Erro(400, 'Variáveis inválidas.');
  if (d.texto != null && (typeof d.texto !== 'string' || d.texto.length > 1500)) throw new Erro(400, 'Texto muito longo.');
}

async function contar(env, chave, limite, ttl) {
  const atual = Number(await env.COTAS.get(chave)) || 0;
  if (atual >= limite) return { ok: false, atual };
  await env.COTAS.put(chave, String(atual + 1), { expirationTtl: ttl });
  return { ok: true, atual: atual + 1 };
}

export async function tratar(req, env, fetchFn = fetch) {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/') return json({ servico: 'kontor-whatsapp', ok: true });
  if (req.method !== 'POST' || url.pathname !== '/enviar') return json({ erro: 'Rota não encontrada.' }, 404);
  try {
    const d = await req.json().catch(() => { throw new Erro(400, 'Pedido inválido.'); });
    const lic = await lerLicenca(d.licenca, env.CHAVE_PUBLICA);
    if (lic.ate < hojeBr()) throw new Erro(403, 'Licença vencida: renove para enviar mensagens.');
    validarPedido(d);

    const mes = hojeBr().slice(0, 7);
    const cota = Number(env.COTA_MENSAL) || 200;
    const minuto = await contar(env, `m:${lic.maquina}:${Math.floor(Date.now() / 60000)}`, 10, 120);
    if (!minuto.ok) throw new Erro(429, 'Muitos envios em sequência. Aguarde um minuto.');
    const usadas = Number(await env.COTAS.get(`q:${lic.maquina}:${mes}`)) || 0;
    if (usadas >= cota) throw new Erro(429, `Cota mensal de ${cota} mensagens atingida.`);

    const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
    const form = new URLSearchParams({ From: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:+${d.para}` });
    const contentSid = env[`CONTENT_SID_${d.tipo.toUpperCase()}`];
    if (contentSid) {
      form.set('ContentSid', contentSid);
      form.set('ContentVariables', JSON.stringify(d.variaveis ?? {}));
    } else {
      if (!d.texto) throw new Erro(400, 'Sem template aprovado para este tipo e sem texto livre.');
      form.set('Body', d.texto);
    }
    const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + btoa(`${sid}:${token}`), 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok) throw new Erro(502, `O WhatsApp recusou o envio${t.message ? ': ' + t.message : '.'}${t.code ? ` (código ${t.code})` : ''}`);
    await env.COTAS.put(`q:${lic.maquina}:${mes}`, String(usadas + 1), { expirationTtl: 40 * 86400 });
    return json({ ok: true, sid: t.sid, status: t.status, usadas: usadas + 1, cota, restante: Math.max(0, cota - usadas - 1) });
  } catch (e) {
    if (e instanceof Erro) return json({ ok: false, erro: e.message }, e.status);
    return json({ ok: false, erro: 'Falha inesperada no serviço de WhatsApp.' }, 500);
  }
}

export default { fetch: (req, env) => tratar(req, env) };
