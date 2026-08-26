create table if not exists public.trilha_checkouts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  email text,
  prize_id text not null,
  extra_qty integer not null default 0,
  bumps jsonb not null default '{}'::jsonb,
  amount_cents integer not null,
  name text,
  document text,
  phone text,
  cep text,
  address text,
  payment_link_id text unique,
  checkout_url text,
  status text not null default 'pending',
  paid_at timestamptz,
  pontohub jsonb not null default '{}'::jsonb
);

create index if not exists trilha_checkouts_status_idx
  on public.trilha_checkouts (status, created_at desc);

alter table public.trilha_checkouts enable row level security;
