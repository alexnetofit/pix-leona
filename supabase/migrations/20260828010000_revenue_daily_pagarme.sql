-- Permite agregar faturamento da Pagar.me (Stone) na tela /guru.
alter table public.revenue_daily drop constraint if exists revenue_daily_platform_check;
alter table public.revenue_daily add constraint revenue_daily_platform_check
  check (platform in ('guru', 'paddle', 'pagou', 'dlocal', 'pagarme'));
