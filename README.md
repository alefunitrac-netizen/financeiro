# Financeiro — controle financeiro pessoal pelo WhatsApp

Você escreve no WhatsApp do seu jeito, e o sistema grava, categoriza e responde:

```
você:  gastei 47,90 no ifood no nubank
bot:   ✅ Registrado: R$ 47,90 — iFood
       📂 Alimentação · 💳 Nubank crédito · 📅 hoje
       🧾 Cai na fatura que vence em 10/12.
```

Também entende parcelamento (`tv 3000 em 10x no itaú`), receitas (`recebi 5000 de salário`),
resumos (`quanto gastei esse mês?`, `quanto foi de mercado em outubro?`), `desfazer` e `corrigir: era 52`.

## Arquitetura

```
WhatsApp (Cloud API oficial da Meta)
   │  webhook assinado (HMAC-SHA256)
   ▼
Supabase Edge Function  whatsapp-webhook
   │  responde 200 na hora e processa em segundo plano
   ├──► Claude (só interpreta o texto → JSON estruturado)
   ├──► Postgres (Supabase): usuarios, contas, categorias, mensagens, transacoes
   └──► WhatsApp: resposta de confirmação
```

Decisões que importam:

| Decisão | Por quê |
|---|---|
| Dinheiro em centavos (`bigint`) | Sem erro de arredondamento de float. |
| A IA só extrai; o código calcula | Centavos, parcelas e vencimento de fatura saem de código testado, não do modelo. |
| Duas datas por transação | `data_transacao` (competência) para orçamento; `data_pagamento` (vencimento da fatura) para fluxo de caixa. |
| Nada é apagado | `desfazer` marca como `cancelado`. Trilha de auditoria completa. |
| `wamid` único em `mensagens` | A Meta reenvia webhooks; reenvio não duplica lançamento. |
| `status` informado/confirmado + `external_id` | Prepara a conciliação com o Open Finance (Fase 2) sem duplicar gastos. |
| Lista de números no banco | Número fora de `usuarios` é ignorado em silêncio. |
| Comandos de uma palavra sem IA | `desfazer`, `ajuda`, `resumo` funcionam mesmo se a API cair. |

## Estrutura

```
supabase/
  migrations/20261107120000_schema_inicial.sql   esquema, gatilhos, função de resumo, RLS
  functions/
    whatsapp-webhook/index.ts                    ponto de entrada (Deno.serve)
    _shared/
      tipos.ts                 tipos de domínio e interfaces (sem dependências)
      processador.ts           núcleo: registrar, desfazer, corrigir, resumir
      dinheiro.ts  datas.ts    centavos, parcelas, vencimento de fatura, períodos
      telefone.ts              normalização do número (nono dígito)
      whatsapp.ts  webhook.ts  assinatura, payload, envio, camada HTTP
      interpretador_claude.ts  prompt + saída estruturada com o Claude
      repositorio_supabase.ts  acesso ao Postgres
      respostas.ts             textos do bot
    tests/                     38 testes (sem rede, sem banco, sem IA)
```

## Rodando os testes

Requer [Deno](https://deno.com) 2.x.

```bash
deno task test
```

```bash
deno task check
```

## Configuração (uma vez)

### 1. Banco e função no Supabase

```bash
supabase link --project-ref <ref-do-projeto>
```

```bash
supabase db push
```

```bash
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

### 2. App no Meta for Developers

1. Em <https://developers.facebook.com/apps>, crie um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Em **WhatsApp → API Setup**, use o número de teste da Meta (ou adicione um número próprio, que **não** pode estar
   em uso no WhatsApp comum) e cadastre o seu celular como destinatário.
3. Gere um token permanente: **Business Settings → System Users → Add**, dê acesso ao app com a permissão
   `whatsapp_business_messaging` e gere o token.
4. Copie o **App Secret** em **App Settings → Basic**.
5. Em **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<ref-do-projeto>.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: o valor de `WHATSAPP_VERIFY_TOKEN`
   - Assine o campo **messages**.

### 3. Segredos da função

Em **Supabase → Edge Functions → Secrets** (nunca no código nem no chat):

| Nome | Valor |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | texto aleatório, o mesmo cadastrado na Meta |
| `WHATSAPP_APP_SECRET` | App Secret do app da Meta |
| `WHATSAPP_ACCESS_TOKEN` | token permanente do System User |
| `ANTHROPIC_API_KEY` | chave da API do Claude (<https://platform.claude.com>) |
| `CLAUDE_MODEL` | opcional; padrão `claude-opus-5-5` |
| `WHATSAPP_API_VERSION` | opcional; padrão `v25.0` |

### 4. Seu usuário e suas contas

```sql
-- Categorias padrão e a conta "Dinheiro" são criadas automaticamente.
insert into usuarios (nome, whatsapp) values ('Seu Nome', '5511987654321');

insert into contas (usuario_id, nome, tipo, apelidos, dia_fechamento, dia_vencimento)
select id, 'Nubank crédito', 'cartao_credito', array['nubank', 'roxinho'], 3, 10
from usuarios where whatsapp = '5511987654321';

insert into contas (usuario_id, nome, tipo, apelidos)
select id, 'Itaú', 'corrente', array['itau', 'pix']
from usuarios where whatsapp = '5511987654321';
```

## Custos (uso pessoal)

- **Supabase:** plano gratuito.
- **WhatsApp:** respostas a mensagens que você enviou, dentro de 24h, não são cobradas.
- **Claude:** cada mensagem custa frações de centavo de dólar; algumas centenas de lançamentos por mês saem por
  poucos dólares. Para baratear, defina `CLAUDE_MODEL=claude-haiku-5-5`.

## Próximas fases

1. **Fase 1 (esta):** lançamentos por texto, parcelamento, faturas, resumos, desfazer/corrigir.
2. **Fase 2:** Open Finance via Pluggy (Meu Pluggy, uso pessoal) + conciliação automática do que você informou com o
   que o banco mostra.
3. **Fase 3:** painel web, orçamento por categoria, alertas de fechamento de fatura, foto de comprovante e áudio.
