# API de integração Leona — contas e billing

Esta documentação descreve os endpoints HTTP que **sistemas externos** (CRM, ERP, gateway de pagamento, automações como o pix-leona, etc.) podem usar para **criar**, **consultar** e **atualizar** contas Leona (empresas), sem login de usuário. A comunicação é **autenticada só por um token Bearer** configurado no servidor Leona.

No projeto **pix-leona**, o mesmo token é exposto como `LEONA_BILLING_TOKEN`; no servidor Leona, a variável é `INTEGRATION_BILLING_BEARER_TOKEN`.

---

## Autenticação

Em **todas** as requisições, envie:

| Header | Valor |
|--------|--------|
| `Authorization` | `Bearer <TOKEN>` — valor de `INTEGRATION_BILLING_BEARER_TOKEN` no Leona |
| `Accept` | `application/json` (recomendado) |
| `Content-Type` | `application/json` (obrigatório nos **POST**) |

O token **não** é cookie de sessão nem API de usuário; é um segredo compartilhado só para esta integração.

---

## Base da URL

Substitua o host pelo ambiente da API Leona (produção, homologação ou `http://127.0.0.1:3000` em desenvolvimento):

```text
https://SEU_DOMINIO_LEONA/api/v1/integration/...
```

Produção atual: `https://apiaws.leonasolutions.io/api/v1/integration/...`

Prefixo fixo: **`/api/v1/integration/`**.

---

## Visão dos endpoints

| Método | Caminho | Uso |
|--------|---------|-----|
| `POST` | `/accounts` | **Criar** conta (migração / onboarding) — define login, slots e vencimento |
| `GET` | `/accounts/billing_profile` | Buscar conta pelo **e-mail** ou **telefone** do **dono (owner)** |
| `GET` | `/accounts/:account_id/billing_profile` | Buscar conta pelo **ID numérico** da conta |
| `POST` | `/accounts/:account_id/billing_profile` | **Atualizar** cobrança (Guru, vencimento, instâncias, status, etc.) |

### Fluxo recomendado

1. **Conta nova (migração):** `POST /accounts` → guarde o `account_id` retornado.
2. **Conta existente:** `GET /accounts/billing_profile?email=...` (ou por `account_id`).
3. **Sincronizar pagamento / Guru / status:** `POST /accounts/:account_id/billing_profile` com os campos necessários.

A busca por e-mail/telefone considera **apenas** usuários com papel **owner** na conta. Membros ou admins com o mesmo e-mail em outra conta **não** entram nessa busca.

---

## Aliases de campos

A API aceita nomes alternativos em português ou sinônimos usados em integrações:

| Preferido (pix-leona) | Alias aceito |
|----------------------|--------------|
| `starter_instances` | `slots` |
| `due_date` | `vencimento` |
| `phone` | `telefone` |
| `status` | `subscription_status` (no POST billing; se ambos vierem, vale `status`) |
| `rewardful_referral` | `affiliate_code` (no POST `/accounts`) |

---

## POST — criar conta (migração)

**Quando usar:** cliente ainda **não** existe no Leona e você quer criar a conta com login, slots e vencimento em uma única chamada (migração de outra plataforma, onboarding manual, etc.).

**Endpoint:**

```text
POST /api/v1/integration/accounts
```

### Corpo da requisição (JSON)

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| `email` | Sim | E-mail de login do cliente |
| `password` | Sim | Senha (mínimo 6 caracteres) |
| `password_confirmation` | Sim | Confirmação da senha |
| `name` | Sim | Nome do cliente (também usado como nome da empresa) |
| `slots` ou `starter_instances` | Sim* | Quantidade de slots **Starter** (UAZAPI / Meta Cloud) |
| `pro_instances` | Não | Quantidade de slots **Pro** (Z-API). Padrão: `0` |
| `due_date` ou `vencimento` | Sim | Data de vencimento (`YYYY-MM-DD`) |
| `phone` ou `telefone` | Não | WhatsApp pessoal do cliente |
| `guru_account_id` | Não | ID da assinatura/conta na Guru (ou outra origem) |
| `affiliate_code` | Não | Código de afiliado (Rewardful) |

\* Informe ao menos **1 slot** entre `slots`/`starter_instances` e `pro_instances`.

### Exemplo

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "email": "cliente@exemplo.com",
    "password": "senha123",
    "password_confirmation": "senha123",
    "name": "Empresa Exemplo",
    "phone": "5511999999999",
    "slots": 2,
    "due_date": "2026-12-31",
    "guru_account_id": "sub_abc123"
  }'
```

### Resposta de sucesso (201)

Mesmo formato do [perfil de billing](#corpo-da-resposta-perfil-de-billing):

```json
{
  "account_id": 42,
  "subscription_type": "custom",
  "user": {
    "name": "Empresa Exemplo",
    "email": "cliente@exemplo.com",
    "phone": "5511999999999"
  },
  "plan_summary": "2 Starter",
  "starter_instances": 2,
  "pro_instances": 0,
  "current_period_end": "2026-12-31T23:59:59-03:00",
  "subscription_status": "active",
  "rewardful_referral": null,
  "guru_account_id": "sub_abc123"
}
```

Guarde o **`account_id`** — ele identifica a conta para consultas e atualizações futuras.

### Erros específicos

| Código | Situação | Exemplo de corpo |
|--------|----------|------------------|
| `400` | Parâmetros ausentes ou inválidos | `{ "error": "Senha é obrigatória" }` |
| `422` | E-mail já cadastrado | `{ "error": "E-mail já está em uso" }` |
| `422` | Regra de negócio | `{ "error": "Preços não encontrados..." }` |

Se o e-mail **já existir**, a API **não** cria de novo — use [GET por e-mail](#get--perfil-por-e-mail-ou-telefone) + [POST billing](#post--atualizar-perfil-de-cobrança), ou oriente o cliente a recuperar a senha.

### Observações

- `slots` = slots Starter (UAZAPI / Meta Cloud).
- O cliente consegue **logar no Leona** com o `email` e `password` enviados nesta chamada.
- Contas criadas assim costumam vir com `subscription_type: "custom"`.

---

## GET — perfil por e-mail ou telefone

**Quando usar:** você conhece o e-mail ou WhatsApp do dono da empresa, mas não o ID interno da conta Leona.

**Query string (obrigatório um dos dois):**

- `email` — e-mail do owner (normalmente minúsculo, sem espaços)
- `phone` ou `telefone` — telefone do owner (aceita formatos comuns; a API normaliza)

**Exemplo (e-mail):**

```bash
curl -sS -G 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/billing_profile' \
  --data-urlencode 'email=don@exemplo.com' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Accept: application/json'
```

**Exemplo (telefone):**

```bash
curl -sS -G 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/billing_profile' \
  --data-urlencode 'phone=5511999999999' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Accept: application/json'
```

**Resposta de sucesso (200):** JSON com o perfil (ver [Corpo da resposta](#corpo-da-resposta-perfil-de-billing)).

**Conflito (409):** o mesmo e-mail ou telefone aparece como **owner em mais de uma conta**. A resposta inclui `account_ids` com os IDs possíveis. Escolha o ID correto (por exemplo via `guru_account_id`) e use o [GET por ID](#get--perfil-por-id-da-conta) ou o [POST billing](#post--atualizar-perfil-de-cobrança).

Exemplo de corpo (409):

```json
{
  "error": "Este e-mail ou telefone aparece como dono (owner) em mais de uma conta. Use account_id na URL: .../integration/accounts/ID/billing_profile.",
  "account_ids": [1, 9, 10]
}
```

---

## GET — perfil por ID da conta

**Quando usar:** você já tem o **ID da conta** no Leona (retorno do `POST /accounts`, admin, retorno 409, checkout `?src=`, etc.).

`account_id` é o número inteiro da tabela `accounts` (ex.: `1`, `42`).

```bash
curl -sS 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Accept: application/json'
```

**Resposta de sucesso (200):** igual à do GET por e-mail/telefone.

**Não encontrado (404):** não existe conta com esse ID.

---

## Corpo da resposta (perfil de billing)

Retornado no **GET** (200), no **POST billing** (200) e no **POST /accounts** (201):

| Campo | Descrição |
|-------|-----------|
| `account_id` | ID da conta no Leona |
| `subscription_type` | Tipo de assinatura (ex.: `stripe` vs `custom`) |
| `user` | Objeto com `name`, `email`, `phone` do contato principal (prioriza owner) |
| `plan_summary` | Texto resumindo planos/instâncias (ex.: `"2 Starter"`, `"10 Starter"`) |
| `starter_instances` | Quantidade de slots Starter |
| `pro_instances` | Quantidade de slots Pro |
| `current_period_end` | Fim do período atual (ISO 8601 com timezone, ex.: `2026-12-31T23:59:59-03:00`) |
| `subscription_status` | Status da assinatura (`active`, `inactive`, `canceled`, `past_due`, etc.) |
| `rewardful_referral` | Referência Rewardful, se houver |
| `guru_account_id` | ID da assinatura/conta na Guru, se vinculado |

Campos podem ser `null` conforme o cadastro.

---

## POST — atualizar perfil de cobrança

**Quando usar:** a conta **já existe** e você precisa sincronizar pagamento, Guru, vencimento, instâncias ou status (webhooks, suporte, scripts).

**Sempre** use `account_id` na URL. O corpo é JSON com os campos que deseja enviar (**atualização parcial** — envie só o que muda).

### Campos do POST

| Campo | Descrição |
|-------|-----------|
| `guru_account_id` | Identificador da assinatura/conta na Guru |
| `due_date` | Data de vencimento (`YYYY-MM-DD`). No Leona, costuma ser **fim do período pago + 1 dia** |
| `starter_instances` | Quantidade desejada de instâncias Starter |
| `pro_instances` | Quantidade desejada de instâncias Pro |
| `status` | Assinatura **custom**: `active`, `canceled`, `past_due`, `inactive` — mesma lógica dos botões “Ativar” / “Cancelar” do admin |
| `subscription_status` | Sinônimo de `status`. Ignorado se `status` estiver preenchido |
| `rewardful_referral` | Código ou referência Rewardful |

**Exemplo (instâncias e Guru):**

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"guru_account_id":"abc123","due_date":"2026-12-31","starter_instances":1,"pro_instances":0}'
```

**Exemplo (inativar após reembolso):**

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"due_date":"2026-06-04","status":"inactive","starter_instances":0}'
```

**Exemplo (reativar assinatura custom cancelada):**

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
```

**Resposta de sucesso (200):** JSON no mesmo formato do GET (perfil atualizado).

**Erros comuns:** `400` (parâmetros inválidos), `404` (conta inexistente), `422` (regra de negócio — mensagem em `error`).

---

## Códigos HTTP resumidos

| Código | Situação |
|--------|----------|
| `200` | Sucesso (GET ou POST billing) |
| `201` | Conta criada com sucesso (`POST /accounts`) |
| `400` | Parâmetros ausentes ou inválidos |
| `401` | Bearer ausente, incorreto ou não confere com `INTEGRATION_BILLING_BEARER_TOKEN` |
| `404` | Conta não encontrada |
| `409` | Várias contas com o mesmo owner para e-mail/telefone — use `account_id` |
| `422` | Regra de negócio (e-mail em uso, preços não encontrados, alteração não permitida, etc.) |
| `503` | Integração não configurada no servidor (token não definido no ambiente) |

---

## Uso no pix-leona

Este repositório consome principalmente os endpoints de **billing** (via `lib/leona.js`):

- Lookup por e-mail com tratamento de **409**
- `POST billing_profile` a partir dos webhooks Guru e Paddle
- Vinculação por `guru_account_id` e parâmetro `?src=<account_id>` no checkout

A criação de conta (`POST /accounts`) está documentada acima para migrações e ferramentas externas; **ainda não há wrapper** dedicado no código do pix-leona.
