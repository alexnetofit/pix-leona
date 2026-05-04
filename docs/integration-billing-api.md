# API de integração — perfil de cobrança (billing)

Esta documentação descreve os endpoints HTTP que o **outro sistema** (CRM, ERP, gateway próprio, etc.) pode usar para consultar e atualizar dados de cobrança de uma **conta Leona** (empresa), sem login de usuário. A comunicação é **autenticada só por um token Bearer** configurado no servidor Leona.

---

## Autenticação

Em **todas** as requisições, envie:

| Header | Valor |
|--------|--------|
| `Authorization` | `Bearer <TOKEN>` — o mesmo valor da variável de ambiente `INTEGRATION_BILLING_BEARER_TOKEN` no servidor Leona |
| `Accept` | `application/json` (recomendado) |
| `Content-Type` | `application/json` (obrigatório no **POST**) |

O token **não** é o cookie de sessão nem a API de usuário; é um segredo compartilhado só para esta integração.

---

## Base da URL

Substitua o host pelo ambiente da API Leona (produção, homologação ou `http://127.0.0.1:3000` em desenvolvimento):

```text
https://SEU_DOMINIO_LEONA/api/v1/integration/...
```

Prefixo fixo: **`/api/v1/integration/`**.

---

## Visão dos endpoints

| Método | Caminho | Uso |
|--------|---------|-----|
| `GET` | `/accounts/billing_profile` | Buscar conta pelo **e-mail** ou **telefone** do **dono (owner)** da empresa |
| `GET` | `/accounts/:account_id/billing_profile` | Buscar conta pelo **ID numérico** da conta no banco Leona |
| `POST` | `/accounts/:account_id/billing_profile` | Atualizar dados (Guru, vencimento, instâncias, status, etc.) — sempre com `account_id` na URL |

A busca por e-mail/telefone considera **apenas** usuários com papel **owner** na conta. Membros ou admins com o mesmo e-mail em outra conta **não** entram nessa busca.

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

**Resposta de sucesso (200):** JSON com o perfil (ver seção [Corpo da resposta GET](#corpo-da-resposta-get)).

**Conflito (409):** o mesmo e-mail ou telefone aparece como **owner em mais de uma conta**. A resposta inclui `account_ids` com os IDs possíveis. Nesse caso, escolha o ID correto e use o [GET por ID](#get--perfil-por-id-da-conta) ou o POST com esse `account_id`.

Exemplo de corpo (409):

```json
{
  "error": "Este e-mail ou telefone aparece como dono (owner) em mais de uma conta. Use account_id na URL: .../integration/accounts/ID/billing_profile.",
  "account_ids": [1, 9, 10]
}
```

---

## GET — perfil por ID da conta

**Quando usar:** você já tem o **ID da conta** no Leona (por exemplo vindo do admin, do retorno 409, ou de outro cadastro).

`account_id` é o número inteiro da tabela `accounts` (ex.: `1`, `42`).

```bash
curl -sS 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Accept: application/json'
```

**Resposta de sucesso (200):** igual à do GET por e-mail/telefone.

**Não encontrado (404):** não existe conta com esse ID.

---

## Corpo da resposta GET

Em caso de sucesso, o JSON segue a ideia abaixo (campos podem ser `null` conforme o cadastro):

| Campo | Descrição |
|-------|-----------|
| `account_id` | ID da conta no Leona |
| `subscription_type` | Tipo de assinatura (ex.: Stripe vs custom), conforme regra de negócio |
| `user` | Objeto com `name`, `email`, `phone` do contato principal (prioriza owner) |
| `plan_summary` | Texto resumindo planos/instâncias |
| `starter_instances` | Quantidade de slots Starter |
| `pro_instances` | Quantidade de slots Pro |
| `current_period_end` | Fim do período atual (ISO 8601 quando existir) |
| `subscription_status` | Status da assinatura |
| `rewardful_referral` | Referência Rewardful, se houver |
| `guru_account_id` | ID da conta na Guru (integração), se configurado |

---

## POST — atualizar perfil de cobrança

**Sempre** use `account_id` na URL. O corpo é JSON com os campos que deseja enviar (parciais são aceitos conforme a regra do servidor).

**Campos frequentes** (todos opcionais na requisição; o servidor valida regras de negócio):

| Campo | Descrição |
|-------|-----------|
| `guru_account_id` | Identificador da conta na Guru |
| `due_date` | Data de vencimento (formato `YYYY-MM-DD`) |
| `starter_instances` | Quantidade desejada de instâncias Starter |
| `pro_instances` | Quantidade desejada de instâncias Pro |
| `status` | Assinatura **custom**: altera o status (`active`, `canceled`, `past_due`, `inactive`). Mesma lógica dos botões “Ativar” / “Cancelar” do admin (usa `CustomSubscriptionService`). Se `status` e `subscription_status` vierem no JSON, vale o `status`. |
| `subscription_status` | Sinônimo de `status` para o POST (útil quando o cliente espelha o campo do GET). Ignorado se `status` estiver preenchido. |
| `rewardful_referral` | Código ou referência Rewardful |

**Exemplo (instâncias e Guru):**

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"guru_account_id":"abc123","due_date":"2026-12-31","starter_instances":1,"pro_instances":0}'
```

**Exemplo (reativar assinatura custom cancelada — equivalente a “Ativar” no modal):**

```bash
curl -sS -X POST 'https://SEU_DOMINIO_LEONA/api/v1/integration/accounts/1/billing_profile' \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
```

Ou com o mesmo nome do GET: `-d '{"subscription_status":"active"}'`.

**Resposta de sucesso (200):** JSON no mesmo formato do GET (perfil atualizado).

**Erros comuns:** `400` (parâmetros inválidos ou faltando regra), `404` (conta inexistente), `422` (regra de negócio não permitiu a alteração — mensagem em `error`).

---

## Códigos HTTP resumidos

| Código | Situação |
|--------|----------|
| `200` | Sucesso (GET ou POST) |
| `400` | Parâmetros ausentes ou inválidos (ex.: GET sem `email`/`phone` quando não há ID na URL) |
| `401` | Bearer ausente, incorreto ou não confere com `INTEGRATION_BILLING_BEARER_TOKEN` |
| `404` | Conta não encontrada |
| `409` | Várias contas com o mesmo owner para e-mail/telefone — use `account_id` |
| `503` | Integração não configurada no servidor (token de integração não definido no ambiente) |

---

