# Paddle-first billing

Este documento descreve a arquitetura nova da página `/paddle`. A página
`/assinatura` permanece legada e não faz parte deste rollout.

## Fonte de verdade

- `leona_account_id`: identidade canônica.
- Paddle: fonte financeira para customers, subscriptions, transactions e
  adjustments.
- Ledger Postgres: vínculo durável entre IDs, intents e eventos.
- Leona billing profile: projeção de acesso (`status`, instâncias e vencimento).
- E-mail: atributo mutável; nunca é usado sozinho para decidir qual conta mudar.

## Entrada segura

O Leona chama `POST /api/paddle-link` server-to-server com
`Authorization: Bearer PADDLE_LINK_ISSUER_TOKEN` e o `account_id`. O billing
busca o perfil pelo ID e devolve um link curto:

```text
https://client.leonaflow.com/paddle?ticket=<HMAC>
```

O navegador troca esse ticket em `/api/paddle-session` por cookie `HttpOnly`,
`Secure`, `SameSite=Lax`. O checkout recebe uma transaction já vinculada ao
`customer_id` canônico e usa `allowLogout:false`.

Durante o rollout, links antigos com `account_id+email` só funcionam quando
`PADDLE_ALLOW_LEGACY_LINKS=true`. O estado final de produção é `false`.

## Regras comerciais

### Cartão

- Compra nova: recurring checkout Paddle.
- Renovação: automática pela subscription.
- Upgrade: `prorated_immediately` + `on_payment_failure: prevent_change`.
- Downgrade: PATCH dos items com `do_not_bill`. A Paddle passa a enxergar a
  quantidade financeira menor, mas a Leona mantém `entitled_quantity` até
  `current_billing_period.ends_at`.
- Cancelamento padrão: `next_billing_period`; acesso permanece até o fim do
  período pago.

### PIX Paddle

PIX é suportado pela Paddle somente para itens one-time em BRL, para comprador
no Brasil. Ele não cria nem renova uma subscription recorrente.

- Cliente novo: compra pré-paga; não há recorrência automática.
- Conta pré-paga ativa: renovação estende o ledger; upgrade é proporcional ao
  tempo restante e downgrade só reduz entitlement no vencimento. Migração para
  cartão espera o ciclo pré-pago terminar para não cobrar períodos sobrepostos.
- Upgrade de subscription existente: transaction one-time vinculada por
  `intent_id`; depois de `transaction.completed`, PATCH da subscription com
  `do_not_bill`.
- Renovação de subscription existente: transaction one-time; depois de
  `transaction.completed`, o ciclo é avançado sem segunda cobrança.
- PIX tardio, duplicado ou pago depois de mudança de ciclo vai para
  `manual_review`.

O checkout nunca libera acesso a partir de evento visual do Paddle.js. A
liberação depende de webhook `transaction.completed`.

### Reembolso e chargeback

- Qualquer refund, total ou parcial, é bloqueado depois de 168 horas da captura.
- Exceção fora do prazo exige ação administrativa separada e auditada.
- Refund `pending_approval` não muda a Leona.
- Refund parcial aprovado não muda entitlement por padrão.
- Refund total aprovado: `status=inactive`, instâncias zero e `due_date` ontem
  em `America/Sao_Paulo`.
- Chargeback aprovado suspende imediatamente.
- Chargeback reverse exige reconciliação; não reativa às cegas.

## Webhooks

O endpoint novo `POST /api/webhook-paddle-ledger` valida `Paddle-Signature`,
persiste o evento e responde rapidamente. O webhook legado
`/api/webhook-paddle` permanece intacto até a troca controlada no Dashboard.
Um worker processa:

- deduplicação por `event_id`;
- ordenação por `occurred_at`;
- versão monotônica de entitlement por conta, impedindo um retry antigo da
  outbox de reativar acesso;
- lease de cinco minutos para recuperar workers interrompidos;
- intents PIX e alterações de subscription;
- adjustments;
- outbox de atualização Leona.

O worker e o reconciliador usam `Authorization: Bearer CRON_SECRET`.

Eventos mínimos no Paddle Dashboard:

- `transaction.completed`
- `transaction.payment_failed`
- `subscription.created`
- `subscription.activated`
- `subscription.updated`
- `subscription.past_due`
- `subscription.paused`
- `subscription.resumed`
- `subscription.canceled`
- `adjustment.created`
- `adjustment.updated`

## Persistência

Projeto Supabase: `Leona Billing` (`qlfieymaalnemmnhxgti`).

Migration:

```text
supabase/migrations/20260723151906_paddle_billing_ledger.sql
```

Tabelas:

- `paddle_billing_accounts`
- `paddle_billing_intents`
- `paddle_webhook_events`
- `paddle_leona_outbox`
- `paddle_billing_audit_log`

Todas têm RLS habilitada e nenhuma policy para `anon`/`authenticated`. O acesso
é exclusivamente server-side com `service_role`.

## Páginas legadas (`/` e `/paddle.html`)

`public/index.html` e `public/paddle.html` continuam usando
`/api/paddle-search` e `/api/paddle-subscription`, mas esses dois endpoints
passaram a exigir identidade server-side:

- cookie de sessão Paddle (cliente) ou `Authorization: Bearer` com
  `TOKEN_ADMIN`/`SUPPORT_CHAT_TOKEN` (staff);
- `account_id` e `email` do body só podem concordar com o cookie, nunca
  substituí-lo;
- `subscription_id`/`transaction_id` são checados contra o customer Paddle do
  dono antes de qualquer leitura ou mutação;
- recurso inexistente e recurso de outro dono devolvem o mesmo `403 NOT_OWNER`,
  para não virar oráculo de enumeração.

Consequência operacional: **`PADDLE_LINK_SECRET` passa a ser obrigatório**.
Sem ele as duas páginas respondem `503 BILLING_SESSION_UNCONFIGURED`. Enquanto
o painel do Leona ainda gerar link com `account_id`+`email`, é preciso manter
`PADDLE_ALLOW_LEGACY_LINKS=true`; a troca para ticket assinado
(`/api/paddle-link`) permite voltar o flag para `false`, que é o estado que
elimina de vez o acesso por e-mail.

Links do customer portal Paddle não viajam mais em resposta de listagem. A
página pede um link novo por clique via `action: portal_session`.

## Rollout

1. Aplicar migration em um projeto/schema de billing aprovado.
2. Configurar as novas envs, inclusive os dois URLs públicos.
3. Em sandbox, apontar uma notification destination para
   `/api/webhook-paddle-ledger`.
4. Testar todos os cenários e eventos duplicados/fora de ordem.
5. Publicar `/paddle` atrás de feature flag/canário.
6. Alterar o gerador de link do Leona para `/api/paddle-link`.
7. Desabilitar `PADDLE_ALLOW_LEGACY_LINKS`.
8. Após estabilidade, apontar `/assinatura` para a experiência Paddle e
   `/assinatura-guru` para a página legada.
