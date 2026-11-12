-- Fish Tracker update 06 (12 Nov 2026)
--  • new record types: genotyping results, health/welfare notes, moves, splits (with details)
--  • project licences (PPL) with expiry dates
--  • weekly summary preferences (email / phone notification / "everything") and phone notification subscriptions
--  • change history now labels pure room/rack changes as "moved"
-- Run once in Supabase › SQL Editor. Safe to run again.

-- records
alter table public.events add column if not exists details jsonb not null default '{}'::jsonb;
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('finclip','genotype','health','death','cull','procedure','transfer','added','recount','split'));

-- project licences
create table if not exists public.licences (
  id         uuid primary key default gen_random_uuid(),
  ppl        text not null unique,
  title      text,
  holder     text,
  expires    date,
  created_at timestamptz not null default now()
);
alter table public.licences enable row level security;
drop policy if exists licences_read  on public.licences;
drop policy if exists licences_admin on public.licences;
create policy licences_read  on public.licences for select to authenticated using (public.can_read());
create policy licences_admin on public.licences for all    to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.licences to authenticated;

-- weekly summary preferences
alter table public.members add column if not exists notify_email boolean not null default true;
alter table public.members add column if not exists notify_push  boolean not null default true;
alter table public.members add column if not exists digest_all   boolean not null default false;

create or replace function public.set_my_prefs(p_email boolean, p_push boolean, p_all boolean) returns void
language sql security definer set search_path = public as $$
  update public.members set notify_email = p_email, notify_push = p_push, digest_all = p_all where user_id = auth.uid()
$$;
grant execute on function public.set_my_prefs(boolean, boolean, boolean) to authenticated;

-- phone notification subscriptions (one per device)
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  keys       jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- history: label moves
create or replace function public.log_stock_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb; n jsonb; k text; diff jsonb := '{}'::jsonb; act text;
begin
  if tg_op = 'INSERT' then
    insert into public.history (stock_id, action, by) values (new.id, 'created', auth.uid());
    return new;
  end if;
  o := to_jsonb(old) - 'updated_at' - 'deleted_at' - 'deleted_by' - 'prev_status';
  n := to_jsonb(new) - 'updated_at' - 'deleted_at' - 'deleted_by' - 'prev_status';
  for k in select jsonb_object_keys(n) loop
    if (o -> k) is distinct from (n -> k) then
      diff := diff || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
    end if;
  end loop;
  if diff = '{}'::jsonb then return new; end if;
  act := case
    when new.status = 'deleted'  and old.status <> 'deleted'  then 'deleted'
    when old.status = 'deleted'  and new.status <> 'deleted'  then 'undeleted'
    when new.status = 'archived' and old.status <> 'archived' then 'archived'
    when old.status = 'archived' and new.status = 'active'    then 'restored'
    when new.regen_date is not null and old.regen_date is null then 'regenerated'
    when new.regen_date is null and old.regen_date is not null then 'regen-cleared'
    when (diff - 'room' - 'location') = '{}'::jsonb then 'moved'
    when diff ?| array['count','females','males'] and (diff - 'count' - 'females' - 'males') = '{}'::jsonb then 'numbers'
    else 'edited' end;
  insert into public.history (stock_id, action, changes, by) values (new.id, act, diff, auth.uid());
  return new;
end $$;

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.licences'; exception when duplicate_object then null; end;
end $$;

select 'Update 06 applied' as status;
