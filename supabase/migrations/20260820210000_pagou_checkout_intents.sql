-- Intents e dedupe da Pagou na /assinatura.
create table if not exists public.pagou_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  email text,
  qty integer not null,
  amount_cents integer not null,
  title text not null,
  checkout_url text,
  status text not null default 'pending',
  pagou_transaction_id text,
  paid_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

create index if not exists pagou_checkout_intents_account_idx
  on public.pagou_checkout_intents (account_id, created_at desc);
create index if not exists pagou_checkout_intents_status_idx
  on public.pagou_checkout_intents (status, created_at desc);

alter table public.pagou_checkout_intents enable row level security;

create table if not exists public.pagou_processed_events (
  event_id text primary key,
  created_at timestamptz not null default now(),
  account_id text,
  action text,
  details jsonb not null default '{}'::jsonb
);

alter table public.pagou_processed_events enable row level security;
