-- Cache diario de faturamento consolidado (tela /guru).
--
-- A API da Guru pagina por cursor e gasta ~3,4s por pagina de 100 transacoes,
-- o que fazia a tela levar ~50s pra 30 dias (e o dobro com o comparativo).
-- Esta tabela guarda um agregado fechado por dia e por plataforma, alimentado
-- por cron, pra tela ler tudo de uma consulta so.
--
-- Segue o padrao das tabelas paddle_*: vive em public porque o app serverless
-- fala com o Supabase via PostgREST, com RLS ligada e sem policy de cliente
-- (apenas a service_role acessa).

create table public.revenue_daily (
  day date not null,
  platform text not null check (platform in ('guru', 'paddle')),
  gross_cents bigint not null default 0,
  net_cents bigint not null default 0,
  sales_count integer not null default 0 check (sales_count >= 0),
  refund_gross_cents bigint not null default 0,
  refund_net_cents bigint not null default 0,
  refund_count integer not null default 0 check (refund_count >= 0),
  -- Snapshot de assinantes ativos no momento em que o dia foi sincronizado.
  -- E metrica de "agora", nao de fluxo: a tela usa o valor do dia mais recente
  -- que tenha snapshot. Fica nulo nos dias preenchidos por carga historica.
  active_subscribers integer check (active_subscribers >= 0),
  -- Quebra do snapshot. So a Paddle preenche: assinatura recorrente x PIX
  -- pre-pago (que nao tem subscription e vale por uma janela de dias).
  active_subscribers_recurring integer check (active_subscribers_recurring >= 0),
  active_subscribers_prepaid integer check (active_subscribers_prepaid >= 0),
  transactions_scanned integer not null default 0,
  source_pages integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, platform)
);

comment on table public.revenue_daily is
  'Agregado diario de receita por plataforma. Populado por /api/cron/revenue-sync.';

-- A PK (day, platform) ja atende o filtro por intervalo de dias. Este indice
-- serve so pro cron achar rapido o que esta desatualizado.
create index revenue_daily_synced_at_idx on public.revenue_daily (synced_at);

alter table public.revenue_daily enable row level security;

revoke all on table public.revenue_daily from anon, authenticated;

grant all on table public.revenue_daily to service_role;
