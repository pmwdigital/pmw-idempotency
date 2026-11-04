create table if not exists public.payment_idempotency (
  key text primary key,
  kind text not null check (kind in ('payment', 'refund')),
  caller_id text,
  request_hash text not null,
  status text not null default 'in_flight' check (status in ('in_flight', 'done')),
  http_status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_idempotency enable row level security;
revoke all on table public.payment_idempotency from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_idempotency to service_role;

create index if not exists payment_idempotency_in_flight_created_idx on public.payment_idempotency (created_at) where status = 'in_flight';

create or replace function public.expire_stale_payment_idempotency()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with gone as (
    delete from public.payment_idempotency
    where status = 'in_flight' and created_at < now() - interval '10 minutes'
    returning 1
  )
  select count(*)::integer from gone;
$$;
revoke all on function public.expire_stale_payment_idempotency() from public, anon, authenticated;
grant execute on function public.expire_stale_payment_idempotency() to service_role;
