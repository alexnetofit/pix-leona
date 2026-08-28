-- Total de assinantes sem cruzar Guru/Paddle/Pagou/dLocal/Pagar.me.
alter table public.revenue_daily
  add column if not exists unique_subscribers integer check (unique_subscribers >= 0);

comment on column public.revenue_daily.unique_subscribers is
  'Total de assinantes sem cruzar plataforma. Gravado no snapshot do dia; a tela /guru usa o valor mais recente.';
