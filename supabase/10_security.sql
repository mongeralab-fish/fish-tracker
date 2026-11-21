-- Fish Tracker update 10 (21 Nov 2026): security
--  1. Only the owner can create, change or remove an owner (admins can no longer promote
--     themselves or demote/remove the owner). The lab always keeps at least one owner.
--  2. Change history now also covers crosses, planned crosses and records (fin clips, culls,
--     genotyping…), plus lab-level changes: members, invites, licences and settings.
-- Run once in Supabase › SQL Editor. Safe to run again.

-- ---------- 1. owner protection ----------
create or replace function public.protect_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Changes made in the Supabase dashboard / SQL Editor (no signed-in app user) are allowed.
  if auth.uid() is null then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner' and not public.is_owner()
       and not exists (select 1 from public.invites i where lower(i.email) = lower(new.email) and i.role = 'owner') then
      raise exception 'Only the owner can add another owner.' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if (old.role = 'owner' or new.role = 'owner') and old.role is distinct from new.role then
      if not public.is_owner() then
        raise exception 'Only the owner can change an owner''s role or make someone owner.' using errcode = '42501';
      end if;
      if old.role = 'owner' and (select count(*) from public.members where role = 'owner') <= 1 then
        raise exception 'The lab must keep at least one owner. Make someone else owner first.' using errcode = '42501';
      end if;
    end if;
    if old.user_id <> new.user_id or lower(old.email) <> lower(new.email) then
      if old.role = 'owner' and not public.is_owner() then
        raise exception 'Only the owner can change an owner''s account.' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- DELETE
  if old.role = 'owner' then
    if not public.is_owner() then
      raise exception 'Only the owner can remove an owner.' using errcode = '42501';
    end if;
    if (select count(*) from public.members where role = 'owner') <= 1 then
      raise exception 'The lab must keep at least one owner.' using errcode = '42501';
    end if;
  end if;
  return old;
end $$;

drop trigger if exists members_protect_owner on public.members;
create trigger members_protect_owner before insert or update or delete on public.members
  for each row execute function public.protect_owner();

create or replace function public.protect_owner_invite() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.role = 'owner' and not public.is_owner() then
    raise exception 'Only the owner can invite another owner.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists invites_protect_owner on public.invites;
create trigger invites_protect_owner before insert or update on public.invites
  for each row execute function public.protect_owner_invite();

-- ---------- 2. change history for crosses, plans and records ----------
create or replace function public.jsonb_diff(o jsonb, n jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; d jsonb := '{}'::jsonb;
begin
  for k in select jsonb_object_keys(coalesce(n, '{}'::jsonb)) union select jsonb_object_keys(coalesce(o, '{}'::jsonb)) loop
    if (o -> k) is distinct from (n -> k) then d := d || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k)); end if;
  end loop;
  return d;
end $$;

create or replace function public.log_record_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'updated_at' - 'created_at' end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'updated_at' - 'created_at' end;
  r jsonb := coalesce(n, o);
  noun text := case tg_table_name when 'crosses' then 'cross' when 'plans' then 'planned cross' else 'record' end;
  verb text;
  diff jsonb;
  label text;
  s1 uuid := nullif(r ->> 'stock_id', '')::uuid;
  s2 uuid;
begin
  if tg_table_name in ('crosses', 'plans') then s2 := nullif(r ->> 'stock2_id', '')::uuid; end if;
  if tg_op = 'INSERT' then verb := 'added'; diff := '{}'::jsonb;
  elsif tg_op = 'DELETE' then verb := 'deleted permanently'; diff := '{}'::jsonb;
  else
    diff := public.jsonb_diff(o, n);
    if diff = '{}'::jsonb then return new; end if;
    verb := case
      when (n ->> 'deleted') = 'true' and coalesce(o ->> 'deleted', 'false') <> 'true' then 'deleted'
      when (o ->> 'deleted') = 'true' and coalesce(n ->> 'deleted', 'false') <> 'true' then 'recovered'
      else 'edited' end;
  end if;
  label := concat_ws(' · ',
    nullif(r ->> 'type', ''),
    nullif(r ->> 'date', ''),
    case when tg_table_name = 'events' and (r ->> 'n') is not null then 'n=' || (r ->> 'n') end);
  if s1 is not null then
    insert into public.history (stock_id, action, changes, note, by) values (s1, noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  if s2 is not null and s2 is distinct from s1 then
    insert into public.history (stock_id, action, changes, note, by) values (s2, noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  if s1 is null and s2 is null then
    insert into public.history (stock_id, action, changes, note, by) values (null, noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['crosses','plans','events'] loop
    execute format('drop trigger if exists %1$s_log on public.%1$s', t);
    execute format('create trigger %1$s_log after insert or update or delete on public.%1$s for each row execute function public.log_record_change()', t);
  end loop;
end $$;

-- ---------- lab-level changes (members, invites, licences, settings) ----------
create or replace function public.log_lab_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'updated_at' - 'created_at' end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'updated_at' - 'created_at' end;
  r jsonb := coalesce(n, o);
  diff jsonb := case when tg_op = 'UPDATE' then public.jsonb_diff(o, n) else '{}'::jsonb end;
  what text := case tg_table_name when 'members' then 'member' when 'invites' then 'invite' when 'licences' then 'licence' else 'settings' end;
begin
  if tg_op = 'UPDATE' and diff = '{}'::jsonb then return new; end if;
  insert into public.history (stock_id, action, changes, note, by)
  values (null,
          what || ' ' || case tg_op when 'INSERT' then 'added' when 'DELETE' then 'removed' else 'changed' end,
          diff,
          nullif(concat_ws(' · ', r ->> 'email', r ->> 'role', r ->> 'ppl'), ''),
          auth.uid());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','invites','licences','settings'] loop
    execute format('drop trigger if exists %1$s_log on public.%1$s', t);
    execute format('create trigger %1$s_log after insert or update or delete on public.%1$s for each row execute function public.log_lab_change()', t);
  end loop;
end $$;

create index if not exists history_stock_idx on public.history(stock_id);
create index if not exists history_at_idx on public.history(at desc);

-- The history stays read-only for everyone in the app (no insert/update/delete rules).
revoke insert, update, delete on public.history from authenticated;

select 'Update 10 applied' as status;
