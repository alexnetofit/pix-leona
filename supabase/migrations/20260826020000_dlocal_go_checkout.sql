-- Intents, dedupe e assinaturas dLocal Go.
create table if not exists public.dlocal_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  email text,
  qty integer not null,
  amount_cents integer not null,
  title text not null,
  checkout_url text,
  status text not null default 'pending',
  dlocal_payment_id text,
  dlocal_plan_id text,
  paid_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

create index if not exists dlocal_checkout_intents_account_idx
  on public.dlocal_checkout_intents (account_id, created_at desc);
create index if not exists dlocal_checkout_intents_status_idx
  on public.dlocal_checkout_intents (status, created_at desc);
create index if not exists dlocal_checkout_intents_payment_idx
  on public.dlocal_checkout_intents (dlocal_payment_id);

alter table public.dlocal_checkout_intents enable row level security;

create table if not exists public.dlocal_processed_events (
  event_id text primary key,
  created_at timestamptz not null default now(),
  account_id text,
  action text,
  details jsonb not null default '{}'::jsonb
);

alter table public.dlocal_processed_events enable row level security;

create table if not exists public.dlocal_subscriptions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  account_id text not null,
  email text,
  qty integer not null,
  plan_id text,
  subscription_id text,
  last_payment_id text,
  status text not null default 'pending',
  details jsonb not null default '{}'::jsonb
);

create unique index if not exists dlocal_subscriptions_account_qty_idx
  on public.dlocal_subscriptions (account_id, qty);
create index if not exists dlocal_subscriptions_email_idx
  on public.dlocal_subscriptions (email);

alter table public.dlocal_subscriptions enable row level security;
