# Financeiro — controle financeiro pessoal por mensagem

Você escreve do seu jeito no Telegram (ou no WhatsApp), e o sistema grava, categoriza e responde:

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
Telegram (Bot API)          WhatsApp (Cloud API da Meta)
   │ segredo no cabeçalho       │ assinatura HMAC-SHA256
   ▼                            ▼
telegram-webhook            whatsapp-webhook          ← Supabase Edge Functions
   └──────────┬─────────────────┘
              ▼  responde 200 na hora e processa em segundo plano
        núcleo (processador)  ── não sabe qual é o canal
              ├──► Claude (só interpreta o texto → JSON estruturado)
              ├──► Postgres: usuarios, contas, categorias, mensagens, transacoes
              └──► resposta no mesmo canal
```

Decisões que importam:

| Decisão | Por quê |
|---|---|
| Dinheiro em centavos (`bigint`) | Sem erro de arredondamento de float. |
| A IA só extrai; o código calcula | Centavos, parcelas e vencimento de fatura saem de código testado, não do modelo. |
| Duas datas por transação | `data_transacao` (competência) para orçamento; `data_pagamento` (vencimento da fatura) para fluxo de caixa. |
| Nada é apagado | `desfazer` marca como `cancelado`. Trilha de auditoria completa. |
| `(canal, id_externo)` único em `mensagens` | Os canais reenviam mensagens; reenvio não duplica lançamento. |
| `status` informado/confirmado + `external_id` | Prepara a conciliação com o Open Finance (Fase 2) sem duplicar gastos. |
| Lista de usuários no banco | Quem não está cadastrado é ignorado. No Telegram, o vínculo é por link de uso único. |
| Comandos de uma palavra sem IA | `desfazer`, `ajuda`, `resumo` funcionam mesmo se a API cair. |

## Estrutura

```
supabase/
  migrations/
    20261107120000_schema_inicial.sql   esquema, gatilhos, função de resumo, RLS
    20261109120000_canal_telegram.sql   usuário com Telegram; mensagens por canal
    20261109130000_origem_telegram.sql  origem 'telegram' nas transações
    20261109140000_open_finance.sql     conexões com o banco, saldo, unicidade do external_id
  functions/
    telegram-webhook/index.ts           entrada do Telegram
    whatsapp-webhook/index.ts           entrada do WhatsApp
    _shared/
      tipos.ts                 tipos de domínio e interfaces (sem dependências)
      processador.ts           núcleo: identificar, registrar, desfazer, corrigir, resumir
      dinheiro.ts  datas.ts    centavos, parcelas, vencimento de fatura, períodos
      telegram.ts              leitura, segredo, envio e configuração do bot
      whatsapp.ts  webhook_whatsapp.ts   assinatura, payload, envio, camada HTTP
      telefone.ts              normalização do número (nono dígito)
      interpretador_regras.ts  entende a mensagem por regras (grátis, sem IA)
      interpretador_hibrido.ts regras primeiro; IA opcional como reserva
      interpretador_claude.ts  prompt + saída estruturada com o Claude (opcional)
      repositorio_supabase.ts  acesso ao Postgres
      ambiente.ts              montagem comum das funções
      respostas.ts             textos do bot
      open_finance.ts          Pluggy: contas, transações, conferência e sincronização
      repositorio_banco.ts     acesso ao Postgres para a sincronização
    tests/                     74 testes (sem rede, sem banco, sem IA)
```

## Rodando os testes

Requer [Deno](https://deno.com) 2.x.

```bash
deno task test
```

```bash
deno task check
```

## Configuração com Telegram (recomendada)

### 1. Banco e função

```bash
supabase link --project-ref <ref-do-projeto>
```

```bash
supabase db push
```

```bash
supabase functions deploy telegram-webhook --no-verify-jwt
```

### 2. Bot no Telegram

1. No Telegram, abra o **@BotFather**, mande `/newbot`, escolha um nome e um usuário terminado em `bot`.
2. Copie o token que ele devolve e salve como segredo `TELEGRAM_BOT_TOKEN` (abaixo).
3. Abra uma vez `https://<ref-do-projeto>.supabase.co/functions/v1/telegram-webhook?acao=configurar`.
   A resposta traz o usuário do bot.

### 3. Segredos da função

Em **Supabase → Edge Functions → Secrets** (nunca no código nem no chat):

| Nome | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token do @BotFather |
| `ANTHROPIC_API_KEY` | opcional: chave da API do Claude, usada só nas frases que as regras não entendem |
| `CLAUDE_MODEL` | opcional; padrão `claude-opus-5-5` (`claude-haiku-5-5` é ~40x mais barato) |
| `INTERPRETADOR` | opcional; `regras` desliga a IA mesmo com chave |

### 4. Seu usuário, contas e vínculo do Telegram

```sql
-- Categorias padrão e a conta "Dinheiro" são criadas automaticamente.
insert into usuarios (nome, codigo_vinculo)
values ('Seu Nome', replace(gen_random_uuid()::text, '-', ''))
returning codigo_vinculo;

insert into contas (usuario_id, nome, tipo, apelidos, dia_fechamento, dia_vencimento)
select id, 'Nubank crédito', 'cartao_credito', array['nubank', 'roxinho'], 3, 10
from usuarios where nome = 'Seu Nome';
```

Abra `https://t.me/<usuario_do_bot>?start=<codigo_vinculo>` no celular e toque em **Iniciar**.
O código vale uma vez. Para ligar outra conta do Telegram, gere um código novo:

```sql
update usuarios set codigo_vinculo = replace(gen_random_uuid()::text, '-', '')
where nome = 'Seu Nome' returning codigo_vinculo;
```

## Open Finance (Pluggy, uso pessoal e gratuito)

1. Conecte seus bancos em <https://meu.pluggy.ai>.
2. Em <https://dashboard.pluggy.ai> (mesma conta): **Applications → sua aplicação → Demo → Connect Account →
   MeuPluggy**. Cada banco vira um *item*; copie o **itemId** em *Connected Items*.
3. Segredos da função: `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` (em *Applications*).
4. Cadastre cada item:

```sql
insert into conexoes_banco (usuario_id, item_id)
select id, '<itemId>' from usuarios where nome = 'Seu Nome';
```

5. Publique a função de novo e agende a leitura (2x por dia):

```sql
select cron.schedule('sincronizar-banco', '13 13,23 * * *',
  $$ select net.http_get('https://<ref-do-projeto>.supabase.co/functions/v1/telegram-webhook?acao=sincronizar') $$);
```

Como funciona: a cada leitura (60 dias para trás e as parcelas futuras), o que você informou e o banco confirmou
vira um lançamento só (valor e data do banco, sua descrição e categoria); o resto entra como novo, categorizado pelas
mesmas regras do bot; o que sumiu do banco é desfeito. No Telegram, *atualizar* lê na hora. A autorização do
Meu Pluggy dura 1 ano; o bot avisa 30 dias antes.

## WhatsApp (opcional)

A Meta exige **verificação da empresa** (CNPJ) antes de liberar mensagens, inclusive no número de teste.
Com a empresa verificada:

1. Publique a função: `supabase functions deploy whatsapp-webhook --no-verify-jwt`.
2. Segredos: `WHATSAPP_VERIFY_TOKEN` (texto aleatório), `WHATSAPP_APP_SECRET` (App Settings → Basic),
   `WHATSAPP_ACCESS_TOKEN` (token permanente de um System User com `whatsapp_business_messaging`),
   `WHATSAPP_API_VERSION` (opcional; padrão `v25.0`).
3. No app da Meta, em **WhatsApp → Configuration → Webhook**: URL
   `https://<ref-do-projeto>.supabase.co/functions/v1/whatsapp-webhook`, o mesmo verify token, campo **messages**.
4. Cadastre o número: `update usuarios set whatsapp = '5511987654321' where nome = 'Seu Nome';`

## Custos (uso pessoal)

- **Supabase:** plano gratuito.
- **Telegram:** gratuito.
- **WhatsApp:** respostas a mensagens que você enviou, dentro de 24h, não são cobradas.
- **Interpretação:** grátis. As regras entendem o jeito comum de anotar (`almoço 35 no nubank`, `uber 23 ontem`,
  `tv 3000 em 10x`). A IA só entra, se houver chave com crédito, nas frases que as regras não entendem.

## Próximas fases

1. **Fase 1 (esta):** lançamentos por texto, parcelamento, faturas, resumos, desfazer/corrigir.
2. **Fase 2:** Open Finance via Pluggy (Meu Pluggy, uso pessoal) + conciliação automática do que você informou com o
   que o banco mostra.
3. **Fase 3:** painel web, orçamento por categoria, alertas de fechamento de fatura, foto de comprovante e áudio.
