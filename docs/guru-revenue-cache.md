# Cache de faturamento da tela /guru

## Por que existe

A tela `/guru` mostra receita consolidada de Guru, Paddle, Pagou, dLocal e Pagar.me. Ela consultava as
duas APIs a cada abertura, e a Guru e lenta de um jeito que nao da pra
contornar no cliente:

| Medicao (30 dias, agosto/2026) | Tempo | Paginas |
| --- | --- | --- |
| Guru, dia a dia com 4 em paralelo | 49,8 s | 67 |
| Guru, intervalo unico paginado | 183,1 s | 53 |
| Paddle, intervalo inteiro | 0,25 s | 1 |

São ~2.600 transacoes em 30 dias, ~100 por pagina, ~3,4 s por pagina. A
paginacao da Guru e por cursor, entao pedir o intervalo inteiro de uma vez fica
**mais lento** (as paginas viram uma fila sequencial). Dia a dia em paralelo e o
melhor que a fonte permite, e ainda assim eram ~50 s — dobrados quando a tela
buscava o periodo anterior pra montar o comparativo.

A solucao foi parar de consultar a Guru na hora da abertura.

## Como funciona

```
cron (5 min)  ─┐
cron (diario) ─┼─> revenue_daily (Supabase) ─> /api/guru-revenue ─> tela /guru
carga manual  ─┘
```

`revenue_daily` guarda um agregado fechado por dia e por plataforma. A tela le
esse agregado, entao a resposta e uma consulta SQL sobre poucas dezenas de
linhas em vez de ~70 paginas de API.

- `lib/revenue-source.js` fala com Guru, Paddle, Pagou, dLocal e Pagar.me e devolve totais por dia.
- `lib/revenue-daily.js` le/grava a tabela e monta o resumo de um intervalo.
- `api/cron/revenue-sync.js` mantem a tabela atualizada.
- `api/guru-revenue.js` responde a tela.

### Janelas do cron

| Janela | Agenda | Cobre | Motivo |
| --- | --- | --- | --- |
| `recent` | `*/5 * * * *` | hoje e ontem | manter o numero do dia fresco |
| `rescan` | `20 7 * * *` (04:20 BRT) | ultimos 30 dias | reembolso e chargeback chegam depois e mudam dia ja fechado |
| `backfill` | manual | `?days=N`, teto 120 | carga inicial do historico |

Carga inicial:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://client.leonaflow.com/api/cron/revenue-sync?window=backfill&days=90"
```

### Frescor e buracos

Dias de hoje/ontem valem 15 minutos; passado disso a propria requisicao da tela
recoleta na fonte (no maximo 2 dias, pra ninguem esperar 50 s sem pedir). Dias
antigos ausentes **nao** sao recoletados automaticamente: a resposta volta com
`cache.status = "partial"` e `days_missing > 0`. O botao "Atualizar dados" envia
`force: true`, que autoriza recoletar o intervalo inteiro.

Sem `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` o endpoint cai no modo `live`,
consultando as fontes a cada chamada — o comportamento antigo, lento mas
correto.

## Comparativo de periodo

O periodo de comparacao e calculado no cliente, porque quem sabe a intencao do
usuario e a tela, e vai no mesmo POST (`compare_start`/`compare_end`). A API
devolve os dois intervalos numa resposta so, em `previous`.

| Preset | Compara com |
| --- | --- |
| Hoje | ontem |
| Ontem | anteontem |
| 7 dias | 7 dias imediatamente anteriores |
| 30 dias | 30 dias imediatamente anteriores |
| Mes | mesmo trecho do mes passado (dia 1 ate o mesmo dia) |
| Mes passado | mes anterior a ele, inteiro |
| Personalizado | janela do mesmo tamanho, imediatamente antes |

Presets de mes usam calendario, nao janela deslizante: em 4 de agosto, "Mes"
(1–4/ago) compara com 1–4/jul, e nao com os 4 dias anteriores a 1/ago. Quando o
mes anterior e mais curto, a data gruda no ultimo dia dele: 31/mar compara com
28/fev.

## Semantica dos valores

- **Guru**: transacao aprovada entra em bruto/liquido. Transacao reembolsada ou
  com chargeback **sai** do bruto e entra so em reembolsos.
- **Paddle**: transacao completada entra em bruto/liquido; havendo ajuste, a
  diferenca entra em reembolsos **sem** sair do bruto.
- Em ambos, o reembolso e atribuido ao dia da venda original, nao ao dia em que
  o reembolso aconteceu. E por isso que a rodada noturna precisa refazer a
  janela recente inteira.
- Valores ficam em centavos (`bigint`) na tabela e viram reais na resposta.
- **Pagou** entra em BRL (o que o cliente pagou). `amount` da API às vezes é
  settlement e não pode ser somado com Guru/Paddle. Assinante = e-mail
  único com pagamento `paid` nos últimos 32 dias (recorrente e avulso
  entram iguais; renovação mensal já recai nessa janela).
- **Pagar.me**: lê as intents da `/assinatura` no Supabase (não lista a conta
  Stone). Ciclo novo e ajuste avulso entram no bruto do dia do pagamento.
  Assinante = e-mail único com pedido `paid` nos últimos 32 dias, **sem** quem
  já está na dLocal/Pagou/Guru.
- `active_subscribers` e snapshot do momento da sincronizacao, nao fluxo do dia.
  Fica gravado no dia em que foi coletado e a tela usa o mais recente; dias de
  carga historica ficam com `null`.
- O total da tela (`unique_subscribers`) nao soma os cards: cada cabeça conta
  uma vez. Quem migrou dLocal → Pagar.me fica só na dLocal.
- Mesmo e-mail com **duas contas Leona ativas** soma as duas no unique (dono
  409 no billing). Clique duplo Pagar.me (mesmo conta/valor/tipo em até 60s)
  conta uma venda — sem estornar.
