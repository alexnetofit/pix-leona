-- Paddle-first billing ledger.
--
-- These tables live in public because the existing serverless app talks to
-- Supabase through PostgREST. RLS is enabled with no client policies: only the
-- server-side service_role may access them.

create extension if not exists pgcrypto with schema extensions;

create table public.paddle_billing_accounts (
  leona_account_id text primary key,
  canonical_email text not null,
  paddle_customer_id text unique,
  paddle_subscription_id text unique,
  financial_quantity integer not null default 0 check (financial_quantity >= 0),
  entitled_quantity integer not null default 0 check (entitled_quantity >= 0),
  pending_downgrade_quantity integer check (pending_downgrade_quantity >= 0),
  pending_downgrade_effective_at timestamptz,
  paid_through timestamptz,
  state text not null default 'unlinked' check (
    state in (
      'unlinked',
      'checkout_pending',
      'active',
      'past_due',
      'paused',
      'canceled',
      'suspended',
      'manual_review'
    )
  ),
  entitlement_version bigint not null default 0 check (entitlement_version >= 0),
  last_paddle_event_at timestamptz,
  last_reconciled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.paddle_billing_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  leona_account_id text not null references public.paddle_billing_accounts(leona_account_id) on delete restrict,
  kind text not null check (
    kind in (
      'subscribe_card',
      'renew_card',
      'upgrade_card',
      'downgrade',
      'subscribe_pix_prepaid',
      'renew_pix',
      'upgrade_pix'
    )
  ),
  status text not null default 'awaiting_payment' check (
    status in (
      'created',
      'awaiting_payment',
      'paid_pending_apply',
      'applying',
      'applied',
      'failed',
      'expired',
      'canceled',
      'manual_review',
      'refund_pending',
      'refunded',
      'disputed'
    )
  ),
  previous_quantity integer check (previous_quantity >= 0),
  target_quantity integer not null check (target_quantity >= 0),
  amount_cents bigint check (amount_cents >= 0),
  currency_code text not null default 'BRL' check (char_length(currency_code) = 3),
  effective_at timestamptz,
  expires_at timestamptz,
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_transaction_id text unique,
  paddle_adjustment_id text unique,
  request_fingerprint text not null,
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  paid_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one open state-changing operation per Leona account.
create unique index paddle_billing_intents_one_open_per_account
  on public.paddle_billing_intents (leona_account_id)
  where status in ('created', 'awaiting_payment', 'paid_pending_apply', 'applying');

create unique index paddle_billing_intents_open_fingerprint
  on public.paddle_billing_intents (leona_account_id, request_fingerprint)
  where status in ('created', 'awaiting_payment', 'paid_pending_apply', 'applying');

create index paddle_billing_intents_account_created_idx
  on public.paddle_billing_intents (leona_account_id, created_at desc);

create table public.paddle_webhook_events (
  event_id text primary key,
  notification_id text,
  event_type text not null,
  occurred_at timestamptz not null,
  entity_id text,
  leona_account_id text,
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index paddle_webhook_events_work_idx
  on public.paddle_webhook_events (status, occurred_at)
  where status in ('pending', 'failed');

create index paddle_webhook_events_account_idx
  on public.paddle_webhook_events (leona_account_id, occurred_at desc);

create table public.paddle_leona_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  leona_account_id text not null,
  source_event_id text references public.paddle_webhook_events(event_id) on delete set null,
  entitlement_version bigint not null check (entitlement_version > 0),
  desired_payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'completed', 'failed', 'dead_letter')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (source_event_id, leona_account_id)
);

create unique index paddle_leona_outbox_account_version_key
  on public.paddle_leona_outbox (leona_account_id, entitlement_version);

create index paddle_leona_outbox_account_status_version_idx
  on public.paddle_leona_outbox (leona_account_id, status, entitlement_version desc);

create index paddle_leona_outbox_work_idx
  on public.paddle_leona_outbox (status, next_attempt_at)
  where status in ('pending', 'failed');

create table public.paddle_billing_audit_log (
  id bigint generated always as identity primary key,
  leona_account_id text,
  actor_type text not null check (actor_type in ('customer', 'support', 'webhook', 'reconciler', 'system')),
  actor_id text,
  action text not null,
  paddle_request_id text,
  source_event_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index paddle_billing_audit_account_idx
  on public.paddle_billing_audit_log (leona_account_id, created_at desc);

create or replace function public.paddle_claim_next_event()
returns setof public.paddle_webhook_events
language sql
set search_path = ''
as $$
  update public.paddle_webhook_events
  set
    status = 'processing',
    attempts = attempts + 1,
    updated_at = now()
  where event_id = (
    select event_id
    from public.paddle_webhook_events
    where (
        (status in ('pending', 'failed') and attempts < 10)
        or (status = 'processing' and updated_at < now() - interval '5 minutes')
      )
    order by occurred_at asc
    for update skip locked
    limit 1
  )
  returning *;
$$;

create or replace function public.paddle_claim_next_outbox()
returns setof public.paddle_leona_outbox
language sql
set search_path = ''
as $$
  update public.paddle_leona_outbox
  set
    status = 'processing',
    attempts = attempts + 1,
    updated_at = now()
  where id = (
    select id
    from public.paddle_leona_outbox
    where (
        (
          status in ('pending', 'failed')
          and next_attempt_at <= now()
          and attempts < 10
        )
        or (status = 'processing' and updated_at < now() - interval '5 minutes')
      )
      and not exists (
        select 1
        from public.paddle_leona_outbox active
        where active.leona_account_id = paddle_leona_outbox.leona_account_id
          and active.status = 'processing'
          and active.updated_at >= now() - interval '5 minutes'
      )
      and entitlement_version = (
        select max(candidate.entitlement_version)
        from public.paddle_leona_outbox candidate
        where candidate.leona_account_id = paddle_leona_outbox.leona_account_id
          and candidate.status in ('pending', 'failed', 'processing')
      )
    order by next_attempt_at asc, created_at asc
    for update skip locked
    limit 1
  )
  returning *;
$$;

create or replace function public.paddle_enqueue_leona(
  p_leona_account_id text,
  p_source_event_id text,
  p_desired_payload jsonb
)
returns setof public.paddle_leona_outbox
language plpgsql
set search_path = ''
as $$
declare
  existing public.paddle_leona_outbox;
  next_version bigint;
  inserted public.paddle_leona_outbox;
begin
  if p_source_event_id is not null then
    select *
    into existing
    from public.paddle_leona_outbox
    where source_event_id = p_source_event_id
      and leona_account_id = p_leona_account_id;
    if found then
      return next existing;
      return;
    end if;
  end if;

  update public.paddle_billing_accounts
  set entitlement_version = entitlement_version + 1
  where leona_account_id = p_leona_account_id
  returning entitlement_version into next_version;
  if next_version is null then
    raise exception 'Paddle billing account not found: %', p_leona_account_id;
  end if;

  insert into public.paddle_leona_outbox (
    leona_account_id,
    source_event_id,
    entitlement_version,
    desired_payload
  )
  values (
    p_leona_account_id,
    p_source_event_id,
    next_version,
    p_desired_payload
  )
  returning * into inserted;
  return next inserted;
end;
$$;

create or replace function public.paddle_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger paddle_billing_accounts_updated_at
  before update on public.paddle_billing_accounts
  for each row execute function public.paddle_set_updated_at();

create trigger paddle_billing_intents_updated_at
  before update on public.paddle_billing_intents
  for each row execute function public.paddle_set_updated_at();

create trigger paddle_webhook_events_updated_at
  before update on public.paddle_webhook_events
  for each row execute function public.paddle_set_updated_at();

create trigger paddle_leona_outbox_updated_at
  before update on public.paddle_leona_outbox
  for each row execute function public.paddle_set_updated_at();

alter table public.paddle_billing_accounts enable row level security;
alter table public.paddle_billing_intents enable row level security;
alter table public.paddle_webhook_events enable row level security;
alter table public.paddle_leona_outbox enable row level security;
alter table public.paddle_billing_audit_log enable row level security;

revoke all on table public.paddle_billing_accounts from anon, authenticated;
revoke all on table public.paddle_billing_intents from anon, authenticated;
revoke all on table public.paddle_webhook_events from anon, authenticated;
revoke all on table public.paddle_leona_outbox from anon, authenticated;
revoke all on table public.paddle_billing_audit_log from anon, authenticated;
revoke execute on function public.paddle_claim_next_event() from public, anon, authenticated;
revoke execute on function public.paddle_claim_next_outbox() from public, anon, authenticated;
revoke execute on function public.paddle_set_updated_at() from public, anon, authenticated;
revoke execute on function public.paddle_enqueue_leona(text, text, jsonb) from public, anon, authenticated;

grant all on table public.paddle_billing_accounts to service_role;
grant all on table public.paddle_billing_intents to service_role;
grant all on table public.paddle_webhook_events to service_role;
grant all on table public.paddle_leona_outbox to service_role;
grant all on table public.paddle_billing_audit_log to service_role;
grant usage, select on sequence public.paddle_billing_audit_log_id_seq to service_role;
grant execute on function public.paddle_claim_next_event() to service_role;
grant execute on function public.paddle_claim_next_outbox() to service_role;
grant execute on function public.paddle_enqueue_leona(text, text, jsonb) to service_role;
