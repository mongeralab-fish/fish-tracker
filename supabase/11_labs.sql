-- Fish Tracker update 11 (Nov 2026): several labs on the fish floor
--  • labs: each lab has its own private stocks, crosses, plans, records, licences, settings, members
--  • Fish-floor admins: create labs and manage people in every lab, but see NO lab data
--  • lab admins invite and manage their own people
--  • partner labs: a lab can give another lab access to one specific tank
--  • Fish-floor stock: lines a lab chooses to share (limited details only) + embryo/fish requests
--  • existing data becomes the "Mongera lab"; the current owner becomes Fish-floor admin
-- Run once in Supabase › SQL Editor. Safe to run again.

-- ============ labs ============
create table if not exists public.labs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
insert into public.labs (name) values
  ('Mongera lab'), ('Wilson-Gestri lab'), ('Bianco lab'), ('Rihel lab'), ('Tada lab'), ('Wong lab')
on conflict (name) do nothing;

create table if not exists public.floor_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- Before labs existed, the lab owner ran everything: they become the first Fish-floor admin.
insert into public.floor_admins (user_id)
select user_id from public.members where role = 'owner'
  and not exists (select 1 from public.floor_admins)
on conflict do nothing;

create or replace function public.mongera_lab() returns uuid
language sql stable security definer set search_path = public as $$ select id from public.labs where name = 'Mongera lab' $$;

-- ============ lab on every record ============
do $$
declare t text;
begin
  foreach t in array array['members','invites','stocks','crosses','plans','events','licences','history'] loop
    execute format('alter table public.%I add column if not exists lab_id uuid references public.labs(id) on delete restrict', t);
    execute format('update public.%I set lab_id = public.mongera_lab() where lab_id is null', t);
  end loop;
end $$;
-- history rows for stock changes keep their stock's lab
update public.history h set lab_id = s.lab_id from public.stocks s where h.stock_id = s.id and h.lab_id is distinct from s.lab_id;

alter table public.members  alter column lab_id set not null;
alter table public.invites  alter column lab_id set not null;
alter table public.stocks   alter column lab_id set not null;
alter table public.crosses  alter column lab_id set not null;
alter table public.plans    alter column lab_id set not null;
alter table public.events   alter column lab_id set not null;
alter table public.licences alter column lab_id set not null;

-- one membership per person per lab; one invite per email per lab; PPL numbers unique within a lab
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'members_pkey' and pg_get_constraintdef(oid) not like '%lab_id%') then
    alter table public.members drop constraint members_pkey;
    alter table public.members add constraint members_pkey primary key (lab_id, user_id);
  end if;
  if exists (select 1 from pg_constraint where conname = 'invites_pkey' and pg_get_constraintdef(oid) not like '%lab_id%') then
    alter table public.invites drop constraint invites_pkey;
    alter table public.invites add constraint invites_pkey primary key (lab_id, email);
  end if;
  if exists (select 1 from pg_constraint where conname = 'licences_ppl_key') then
    alter table public.licences drop constraint licences_ppl_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licences_lab_ppl_key') then
    alter table public.licences add constraint licences_lab_ppl_key unique (lab_id, ppl);
  end if;
end $$;

-- new tank fields
alter table public.stocks add column if not exists partner_labs  uuid[] not null default '{}';
alter table public.stocks add column if not exists shared_floor  boolean not null default false;
alter table public.stocks add column if not exists availability  text;
alter table public.stocks add column if not exists share_contact uuid;
alter table public.stocks add column if not exists zfin          text;
alter table public.stocks add column if not exists background    text;

create index if not exists stocks_lab_idx   on public.stocks(lab_id);
create index if not exists crosses_lab_idx  on public.crosses(lab_id);
create index if not exists plans_lab_idx    on public.plans(lab_id);
create index if not exists events_lab_idx   on public.events(lab_id);
create index if not exists members_user_idx on public.members(user_id);
create index if not exists history_lab_idx  on public.history(lab_id);

-- per-lab settings (the old single-row "settings" table is kept untouched as a fallback)
create table if not exists public.lab_settings (
  lab_id     uuid primary key references public.labs(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.lab_settings (lab_id, data)
select public.mongera_lab(), coalesce((select data from public.settings where id = 1), '{}'::jsonb)
on conflict (lab_id) do nothing;
insert into public.lab_settings (lab_id) select id from public.labs on conflict (lab_id) do nothing;

-- embryo / fish requests between labs
create table if not exists public.requests (
  id               uuid primary key default gen_random_uuid(),
  from_lab         uuid not null references public.labs(id) on delete cascade,
  to_lab           uuid not null references public.labs(id) on delete cascade,
  stock_id         uuid references public.stocks(id) on delete set null,
  line_name        text not null,
  wants            text,
  message          text,
  status           text not null default 'open' check (status in ('open','accepted','declined','done','cancelled')),
  reply            text,
  by               uuid not null default auth.uid(),
  replied_by       uuid,
  created_at       timestamptz not null default now(),
  replied_at       timestamptz,
  notified_at      timestamptz,
  reply_notified_at timestamptz
);

-- ============ role helpers ============
create or replace function public.lab_role(p_lab uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where user_id = auth.uid() and lab_id = p_lab
$$;
create or replace function public.lab_can_read(p_lab uuid)  returns boolean language sql stable as $$ select public.lab_role(p_lab) is not null $$;
create or replace function public.lab_can_write(p_lab uuid) returns boolean language sql stable as $$ select coalesce(public.lab_role(p_lab) in ('owner','admin','member'), false) $$;
create or replace function public.lab_is_admin(p_lab uuid)  returns boolean language sql stable as $$ select coalesce(public.lab_role(p_lab) in ('owner','admin'), false) $$;
create or replace function public.lab_is_owner(p_lab uuid)  returns boolean language sql stable as $$ select coalesce(public.lab_role(p_lab) = 'owner', false) $$;
create or replace function public.is_floor_admin() returns boolean
language sql stable security definer set search_path = public as $$ select exists (select 1 from public.floor_admins where user_id = auth.uid()) $$;
create or replace function public.is_floor_user() returns boolean
language sql stable security definer set search_path = public as $$ select exists (select 1 from public.members where user_id = auth.uid()) $$;
create or replace function public.my_labs() returns setof uuid
language sql stable security definer set search_path = public as $$ select lab_id from public.members where user_id = auth.uid() $$;
create or replace function public.my_write_labs() returns setof uuid
language sql stable security definer set search_path = public as $$ select lab_id from public.members where user_id = auth.uid() and role in ('owner','admin','member') $$;

-- a tank is visible to its lab and to its partner labs
create or replace function public.stock_readable(p_lab uuid, p_partners uuid[]) returns boolean
language sql stable as $$ select p_lab in (select public.my_labs()) or coalesce(p_partners && array(select public.my_labs()), false) $$;
create or replace function public.stock_writable(p_lab uuid, p_partners uuid[]) returns boolean
language sql stable as $$ select p_lab in (select public.my_write_labs()) or coalesce(p_partners && array(select public.my_write_labs()), false) $$;
create or replace function public.stock_id_readable(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stocks s where s.id = p_id and public.stock_readable(s.lab_id, s.partner_labs))
$$;
create or replace function public.stock_id_writable(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stocks s where s.id = p_id and public.stock_writable(s.lab_id, s.partner_labs))
$$;

-- the old single-lab helpers now fail closed (nothing should use them any more)
create or replace function public.my_role()  returns text    language sql stable security definer set search_path = public as $$ select role from public.members where user_id = auth.uid() and lab_id = public.mongera_lab() $$;
create or replace function public.can_read()  returns boolean language sql stable as $$ select false $$;
create or replace function public.can_write() returns boolean language sql stable as $$ select false $$;
create or replace function public.is_admin()  returns boolean language sql stable as $$ select false $$;
create or replace function public.is_owner()  returns boolean language sql stable as $$ select false $$;

-- which lab a new record belongs to when the app doesn't say (older app versions): the person's first lab
create or replace function public.default_lab() returns uuid
language sql stable security definer set search_path = public as $$
  select lab_id from public.members where user_id = auth.uid() order by created_at limit 1
$$;
do $$
declare t text;
begin
  foreach t in array array['stocks','crosses','plans','events','licences'] loop
    execute format('alter table public.%I alter column lab_id set default public.default_lab()', t);
  end loop;
end $$;

-- a record never changes lab (except by a Fish-floor admin in the dashboard)
create or replace function public.keep_lab() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lab_id is distinct from old.lab_id and auth.uid() is not null then new.lab_id := old.lab_id; end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['stocks','crosses','plans','events','licences'] loop
    execute format('drop trigger if exists %1$s_keep_lab on public.%1$s', t);
    execute format('create trigger %1$s_keep_lab before update on public.%1$s for each row execute function public.keep_lab()', t);
  end loop;
end $$;

-- ============ sign-in: claim every pending invite, return my labs ============
create or replace function public.claim_invites() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then return null; end if;
  insert into public.members (lab_id, user_id, email, role)
  select i.lab_id, auth.uid(), v_email, i.role from public.invites i where lower(i.email) = v_email
  on conflict (lab_id, user_id) do nothing;
  delete from public.invites where lower(email) = v_email;
  -- keep the same display name across labs
  update public.members m set display_name = x.display_name
    from (select display_name from public.members where user_id = auth.uid() and display_name is not null limit 1) x
   where m.user_id = auth.uid() and m.display_name is null;
  return jsonb_build_object(
    'floor_admin', public.is_floor_admin(),
    'labs', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'role', m.role) order by l.name)
                        from public.members m join public.labs l on l.id = m.lab_id where m.user_id = auth.uid()), '[]'::jsonb));
end $$;

-- older app versions: role in the Mongera lab
create or replace function public.claim_invite() returns text
language plpgsql security definer set search_path = public as $$
begin
  perform public.claim_invites();
  return (select role from public.members where user_id = auth.uid() and lab_id = public.mongera_lab());
end $$;

create or replace function public.set_my_name(p_name text) returns void
language sql security definer set search_path = public as $$
  update public.members set display_name = left(trim(p_name), 60) where user_id = auth.uid()
$$;

drop function if exists public.set_my_prefs(boolean, boolean, boolean, uuid);
create or replace function public.set_my_prefs(p_email boolean, p_push boolean, p_all boolean, p_lab uuid) returns void
language sql security definer set search_path = public as $$
  update public.members set notify_email = p_email, notify_push = p_push, digest_all = p_all where user_id = auth.uid() and lab_id = p_lab
$$;
create or replace function public.set_my_prefs(p_email boolean, p_push boolean, p_all boolean) returns void
language sql security definer set search_path = public as $$
  update public.members set notify_email = p_email, notify_push = p_push, digest_all = p_all where user_id = auth.uid()
$$;

-- names (only names) of anyone on the floor, e.g. who edited a partner-lab tank or who to contact for a shared line
create or replace function public.people_names(p_ids uuid[]) returns table (user_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select distinct on (m.user_id) m.user_id, coalesce(nullif(m.display_name, ''), split_part(m.email, '@', 1))
    from public.members m where m.user_id = any(p_ids) and public.is_floor_user()
   order by m.user_id, m.created_at
$$;

-- ============ the Fish-floor stock (shared lines, limited details) ============
create or replace function public.floor_library() returns table (
  lab_id uuid, lab_name text, line text, zfin text, fluors text[], generation text, zygosity text,
  background text, wild_type boolean, availability text, contact_id uuid, contact_name text, contact_email text,
  stock_id uuid, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (s.lab_id, lower(regexp_replace(coalesce(nullif(s.name,''), s.line, s.stock), '\s+', '', 'g')))
         s.lab_id, l.name,
         coalesce(nullif(s.name, ''), nullif(s.line, ''), s.stock),
         s.zfin, s.fluors, s.generation, s.zygosity, s.background,
         (s.category = 'Wild type'), s.availability,
         coalesce(s.share_contact, s.keepers[1], s.created_by),
         (select coalesce(nullif(m.display_name,''), split_part(m.email,'@',1)) from public.members m where m.user_id = coalesce(s.share_contact, s.keepers[1], s.created_by) and m.lab_id = s.lab_id),
         (select m.email from public.members m where m.user_id = coalesce(s.share_contact, s.keepers[1], s.created_by) and m.lab_id = s.lab_id),
         s.id, s.updated_at
    from public.stocks s join public.labs l on l.id = s.lab_id
   where s.shared_floor and s.status = 'active' and public.is_floor_user()
   order by s.lab_id, lower(regexp_replace(coalesce(nullif(s.name,''), s.line, s.stock), '\s+', '', 'g')), s.updated_at desc
$$;

-- ============ change history keeps the lab ============
create or replace function public.log_stock_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb; n jsonb; k text; diff jsonb := '{}'::jsonb; act text;
begin
  if tg_op = 'INSERT' then
    insert into public.history (stock_id, lab_id, action, by) values (new.id, new.lab_id, 'created', auth.uid());
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
    when new.shared_floor and not old.shared_floor then 'shared on the floor'
    when old.shared_floor and not new.shared_floor then 'removed from the floor stock'
    when (diff - 'room' - 'location') = '{}'::jsonb then 'moved'
    when diff ?| array['count','females','males'] and (diff - 'count' - 'females' - 'males') = '{}'::jsonb then 'numbers'
    else 'edited' end;
  insert into public.history (stock_id, lab_id, action, changes, by) values (new.id, new.lab_id, act, diff, auth.uid());
  return new;
end $$;

create or replace function public.log_record_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'updated_at' - 'created_at' end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'updated_at' - 'created_at' end;
  r jsonb := coalesce(n, o);
  noun text := case tg_table_name when 'crosses' then 'cross' when 'plans' then 'planned cross' else 'record' end;
  verb text; diff jsonb; label text;
  lab uuid := nullif(r ->> 'lab_id', '')::uuid;
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
  label := concat_ws(' · ', nullif(r ->> 'type', ''), nullif(r ->> 'date', ''),
    case when tg_table_name = 'events' and (r ->> 'n') is not null then 'n=' || (r ->> 'n') end);
  if s1 is not null then
    insert into public.history (stock_id, lab_id, action, changes, note, by)
    values (s1, coalesce((select lab_id from public.stocks where id = s1), lab), noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  if s2 is not null and s2 is distinct from s1 then
    insert into public.history (stock_id, lab_id, action, changes, note, by)
    values (s2, coalesce((select lab_id from public.stocks where id = s2), lab), noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  if s1 is null and s2 is null then
    insert into public.history (stock_id, lab_id, action, changes, note, by) values (null, lab, noun || ' ' || verb, diff, nullif(label, ''), auth.uid());
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.log_lab_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'updated_at' - 'created_at' end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'updated_at' - 'created_at' end;
  r jsonb := coalesce(n, o);
  diff jsonb := case when tg_op = 'UPDATE' then public.jsonb_diff(o, n) else '{}'::jsonb end;
  what text := case tg_table_name when 'members' then 'member' when 'invites' then 'invite' when 'licences' then 'licence'
                                  when 'labs' then 'lab' when 'floor_admins' then 'Fish-floor admin' else 'settings' end;
  lab uuid := case when tg_table_name = 'labs' then nullif(r ->> 'id', '')::uuid else nullif(r ->> 'lab_id', '')::uuid end;
begin
  if tg_op = 'UPDATE' and diff = '{}'::jsonb then return new; end if;
  insert into public.history (stock_id, lab_id, action, changes, note, by)
  values (null, lab,
          what || ' ' || case tg_op when 'INSERT' then 'added' when 'DELETE' then 'removed' else 'changed' end,
          diff, nullif(concat_ws(' · ', r ->> 'name', r ->> 'email', r ->> 'role', r ->> 'ppl'), ''), auth.uid());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','invites','licences','lab_settings','labs','floor_admins'] loop
    execute format('drop trigger if exists %1$s_log on public.%1$s', t);
    execute format('create trigger %1$s_log after insert or update or delete on public.%1$s for each row execute function public.log_lab_change()', t);
  end loop;
  foreach t in array array['crosses','plans','events'] loop
    execute format('drop trigger if exists %1$s_log on public.%1$s', t);
    execute format('create trigger %1$s_log after insert or update or delete on public.%1$s for each row execute function public.log_record_change()', t);
  end loop;
end $$;
drop trigger if exists settings_log on public.settings;

-- ============ owner protection, per lab ============
create or replace function public.protect_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare lab uuid := coalesce(new.lab_id, old.lab_id);
begin
  if auth.uid() is null or public.is_floor_admin() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.role = 'owner' and not public.lab_is_owner(lab)
       and not exists (select 1 from public.invites i where i.lab_id = new.lab_id and lower(i.email) = lower(new.email) and i.role = 'owner') then
      raise exception 'Only the lab owner can add another owner.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.lab_id is distinct from old.lab_id then
      raise exception 'Membership can''t be moved to another lab. Invite the person to that lab instead.' using errcode = '42501';
    end if;
    if (old.role = 'owner' or new.role = 'owner') and old.role is distinct from new.role then
      if not public.lab_is_owner(lab) then
        raise exception 'Only the lab owner can change an owner''s role or make someone owner.' using errcode = '42501';
      end if;
      if old.role = 'owner' and (select count(*) from public.members where lab_id = lab and role = 'owner') <= 1 then
        raise exception 'The lab must keep at least one owner. Make someone else owner first.' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;
  if old.role = 'owner' then
    if not public.lab_is_owner(lab) then raise exception 'Only the lab owner can remove an owner.' using errcode = '42501'; end if;
    if (select count(*) from public.members where lab_id = lab and role = 'owner') <= 1 then
      raise exception 'The lab must keep at least one owner.' using errcode = '42501';
    end if;
  end if;
  return old;
end $$;

create or replace function public.protect_owner_invite() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_floor_admin() then return new; end if;
  if new.role = 'owner' and not public.lab_is_owner(new.lab_id) then
    raise exception 'Only the lab owner can invite another owner.' using errcode = '42501';
  end if;
  return new;
end $$;

-- requests: who may change what
create or replace function public.guard_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new."by" := auth.uid(); new.status := 'open'; new.reply := null; new.replied_by := null; new.replied_at := null;
    new.notified_at := null; new.reply_notified_at := null;
    return new;
  end if;
  if public.lab_can_write(old.to_lab) and new.status in ('accepted','declined','done') then
    new.replied_by := auth.uid(); new.replied_at := now(); new.reply_notified_at := null;
  elsif old."by" = auth.uid() and new.status = 'cancelled' then
    null;
  else
    raise exception 'You can''t change this request.' using errcode = '42501';
  end if;
  new.from_lab := old.from_lab; new.to_lab := old.to_lab; new."by" := old."by"; new.line_name := old.line_name;
  new.stock_id := old.stock_id; new.message := old.message; new.wants := old.wants; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists requests_guard on public.requests;
create trigger requests_guard before insert or update on public.requests for each row execute function public.guard_request();

-- ============ access rules ============
alter table public.labs         enable row level security;
alter table public.floor_admins enable row level security;
alter table public.lab_settings enable row level security;
alter table public.requests     enable row level security;

drop policy if exists labs_read  on public.labs;
drop policy if exists labs_admin on public.labs;
create policy labs_read  on public.labs for select to authenticated using (public.is_floor_user() or public.is_floor_admin());
create policy labs_admin on public.labs for all    to authenticated using (public.is_floor_admin()) with check (public.is_floor_admin());

drop policy if exists floor_admins_read on public.floor_admins;
create policy floor_admins_read on public.floor_admins for select to authenticated using (public.is_floor_admin() or user_id = auth.uid());

drop policy if exists members_read  on public.members;
drop policy if exists members_admin on public.members;
create policy members_read  on public.members for select to authenticated
  using (user_id = auth.uid() or public.lab_can_read(lab_id) or public.is_floor_admin());
create policy members_admin on public.members for all to authenticated
  using (public.lab_is_admin(lab_id) or public.is_floor_admin()) with check (public.lab_is_admin(lab_id) or public.is_floor_admin());

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all to authenticated
  using (public.lab_is_admin(lab_id) or public.is_floor_admin()) with check (public.lab_is_admin(lab_id) or public.is_floor_admin());

drop policy if exists lab_settings_read  on public.lab_settings;
drop policy if exists lab_settings_write on public.lab_settings;
create policy lab_settings_read  on public.lab_settings for select to authenticated using (public.lab_can_read(lab_id));
create policy lab_settings_write on public.lab_settings for update to authenticated using (public.lab_is_admin(lab_id)) with check (public.lab_is_admin(lab_id));
-- the old shared settings row is no longer readable from the app
drop policy if exists settings_read  on public.settings;
drop policy if exists settings_write on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.lab_can_read(public.mongera_lab()));

drop policy if exists stocks_read   on public.stocks;
drop policy if exists stocks_insert on public.stocks;
drop policy if exists stocks_update on public.stocks;
drop policy if exists stocks_delete on public.stocks;
create policy stocks_read   on public.stocks for select to authenticated using (public.stock_readable(lab_id, partner_labs));
create policy stocks_insert on public.stocks for insert to authenticated with check (public.lab_can_write(lab_id));
create policy stocks_update on public.stocks for update to authenticated
  using (public.stock_writable(lab_id, partner_labs)) with check (public.stock_writable(lab_id, partner_labs));
create policy stocks_delete on public.stocks for delete to authenticated using (public.lab_is_owner(lab_id));

do $$
declare t text;
begin
  foreach t in array array['crosses','plans','events'] loop
    execute format('drop policy if exists %1$s_read   on public.%1$s', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.lab_can_read(lab_id) or public.stock_id_readable(stock_id)%2$s)', t,
                   case when t = 'events' then '' else ' or public.stock_id_readable(stock2_id)' end);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.lab_can_write(lab_id) and (stock_id is null or public.stock_id_writable(stock_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.lab_can_write(lab_id) or public.stock_id_writable(stock_id)) with check (public.lab_can_write(lab_id) or public.stock_id_writable(stock_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.lab_is_owner(lab_id))', t);
  end loop;
end $$;

drop policy if exists licences_read  on public.licences;
drop policy if exists licences_admin on public.licences;
create policy licences_read  on public.licences for select to authenticated using (public.lab_can_read(lab_id));
create policy licences_admin on public.licences for all    to authenticated using (public.lab_is_admin(lab_id)) with check (public.lab_is_admin(lab_id));

drop policy if exists history_read on public.history;
create policy history_read on public.history for select to authenticated using (
  (stock_id is not null and public.stock_id_readable(stock_id))
  or (stock_id is null and public.lab_can_read(lab_id))
  or (stock_id is null and public.is_floor_admin() and (action like 'member %' or action like 'invite %' or action like 'lab %' or action like 'Fish-floor admin %')));

drop policy if exists requests_read   on public.requests;
drop policy if exists requests_insert on public.requests;
drop policy if exists requests_update on public.requests;
create policy requests_read   on public.requests for select to authenticated using (public.lab_can_read(from_lab) or public.lab_can_read(to_lab));
create policy requests_insert on public.requests for insert to authenticated with check (public.lab_can_read(from_lab) and from_lab <> to_lab);
create policy requests_update on public.requests for update to authenticated using (public.lab_can_write(to_lab) or "by" = auth.uid()) with check (true);

-- ============ permissions ============
revoke all on public.labs, public.floor_admins, public.lab_settings, public.requests from anon;
grant select, insert, update, delete on public.labs, public.lab_settings, public.requests to authenticated;
grant select on public.floor_admins to authenticated;
revoke insert, update, delete on public.history from authenticated;
grant execute on function public.claim_invites(), public.claim_invite(), public.floor_library(), public.people_names(uuid[]),
  public.set_my_prefs(boolean, boolean, boolean, uuid), public.set_my_prefs(boolean, boolean, boolean), public.set_my_name(text),
  public.lab_role(uuid), public.is_floor_admin() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['labs','lab_settings','requests'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t); exception when duplicate_object then null; end;
  end loop;
end $$;

select 'Update 11 applied' as status, (select count(*) from public.labs) as labs,
       (select count(*) from public.floor_admins) as floor_admins;
