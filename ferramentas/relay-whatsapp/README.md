# Relay de WhatsApp (Twilio) — Kontor

Serviço pequeno (Cloudflare Worker) que envia as mensagens de WhatsApp dos sistemas Kontor
(Empresas, Contabilidade e Transportadora) usando **uma única conta Twilio da Kontor**.
As credenciais ficam só aqui; os programas instalados nos clientes só pedem o envio.

## O que o serviço confere
1. **Licença**: o programa manda o código de licença; o Worker confere a assinatura (a mesma chave pública do sistema) e a validade.
2. **Cota**: 200 mensagens por mês por computador (`COTA_MENSAL`) e no máximo 10 por minuto.
3. **Pedido**: tipo (lembrete, atraso, nota, pagamento), número `55 + DDD + número` e variáveis do template.

## Publicar (uma vez)
```bash
cd ferramentas/relay-whatsapp
npm i -g wrangler && wrangler login
wrangler kv namespace create COTAS          # copie o id para o wrangler.toml
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
# edite wrangler.toml: TWILIO_WHATSAPP_FROM e os CONTENT_SID_*
wrangler deploy
```
Depois associe a rota do domínio (ex.: `wa.kontorgestao.com.br/*`) ao Worker, no painel do Cloudflare.
Teste: `curl https://wa.kontorgestao.com.br/` deve responder `{"servico":"kontor-whatsapp","ok":true}`.

## Templates a aprovar no Twilio (WhatsApp, categoria Utilidade)
As variáveis são posicionais. Crie cada template em *Content Template Builder* e cole o `HX...` no `wrangler.toml`.

| Tipo | Texto (variáveis) |
|---|---|
| **lembrete** | `Olá, {{1}}! Passando para lembrar que a cobrança de {{2}} vence em {{3}}. Qualquer dúvida, estamos à disposição. {{4}}` |
| **atraso** | `Olá, {{1}}! Identificamos que a cobrança de {{2}}, com vencimento em {{3}}, ainda não consta como paga. Se já pagou, desconsidere esta mensagem. {{4}}` |
| **nota** | `Olá, {{1}}! Sua NFS-e nº {{2}} ({{3}}) foi emitida por {{4}}. Para ver e baixar o PDF e o XML: {{5}}` |
| **pagamento** | `Olá, {{1}}! Recebemos o pagamento de {{2}}. Obrigado! {{3}}` |

Enquanto um template não estiver aprovado (`CONTENT_SID_*` vazio), o Worker envia o texto livre,
que só chega dentro da janela de 24 horas ou no sandbox do Twilio.

## Segurança e custo
- Credenciais do Twilio nunca vão para o programa nem para o repositório.
- A cota por licença limita o custo; ajuste `COTA_MENSAL` e republique.
- O cliente final só recebe mensagem se o cadastro dele estiver marcado como "autorizou receber WhatsApp".
