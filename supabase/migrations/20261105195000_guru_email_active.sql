-- Cache de "esse e-mail ainda tem assinatura Leona ativa na Guru", usado pelo
-- snapshot de assinantes (lib/guru-email-cache.js). Cada e-mail é consultado
-- uma vez e só volta pra fila quando recheck_at vence.
create table if not exists public.guru_email_active (
  email text primary key,
  active boolean,
  cycle_end date,
  checked_at timestamptz,
  recheck_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists guru_email_active_recheck_at_idx
  on public.guru_email_active (recheck_at);

alter table public.guru_email_active enable row level security;
revoke all on public.guru_email_active from anon, authenticated;
