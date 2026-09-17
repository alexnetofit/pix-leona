create table if not exists public.trilha_100k_group_phones (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  email text,
  phone text not null,
  unique (account_id, phone)
);

create index if not exists trilha_100k_group_phones_account_idx
  on public.trilha_100k_group_phones (account_id, created_at desc);

create or replace function public.trilha_100k_group_phones_limit()
returns trigger
language plpgsql
as $$
begin
  if (
    select count(*) from public.trilha_100k_group_phones
    where account_id = new.account_id
  ) >= 3 then
    raise exception 'phone limit reached';
  end if;
  return new;
end;
$$;

drop trigger if exists trilha_100k_group_phones_limit_trg on public.trilha_100k_group_phones;
create trigger trilha_100k_group_phones_limit_trg
before insert on public.trilha_100k_group_phones
for each row execute function public.trilha_100k_group_phones_limit();

alter table public.trilha_100k_group_phones enable row level security;
revoke all on public.trilha_100k_group_phones from anon, authenticated;
