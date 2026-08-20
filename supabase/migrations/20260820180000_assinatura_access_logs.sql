-- Log de acessos e acoes da pagina /assinatura (Guru + Pagou).
-- RLS ligada, sem policy de cliente: so service_role via PostgREST.

create table public.assinatura_access_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null,
  provider text not null default 'guru',
  email text,
  account_id text,
  details jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text
);

comment on table public.assinatura_access_logs is
  'Acessos e acoes da pagina /assinatura (Guru e Pagou) para monitorar a migracao.';

create index assinatura_access_logs_created_at_idx
  on public.assinatura_access_logs (created_at desc);
create index assinatura_access_logs_email_idx
  on public.assinatura_access_logs (email);
create index assinatura_access_logs_account_id_idx
  on public.assinatura_access_logs (account_id);
create index assinatura_access_logs_provider_idx
  on public.assinatura_access_logs (provider);

alter table public.assinatura_access_logs enable row level security;
