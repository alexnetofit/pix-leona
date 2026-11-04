-- Cache de "quantas contas Leona ativas esse e-mail tem", usado pelo snapshot
-- de assinantes (lib/leona-account-cache.js). Cada e-mail é consultado na
-- Leona uma vez e só volta pra fila quando recheck_at vence.
create table if not exists public.leona_email_accounts (
  email text primary key,
  account_ids jsonb not null default '[]'::jsonb,
  active_count integer,
  profiles_count integer,
  checked_at timestamptz,
  recheck_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists leona_email_accounts_recheck_at_idx
  on public.leona_email_accounts (recheck_at);

alter table public.leona_email_accounts enable row level security;
revoke all on public.leona_email_accounts from anon, authenticated;
