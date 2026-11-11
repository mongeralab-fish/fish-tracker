-- ============================================================
-- Fish Tracker — database setup (run once in Supabase › SQL Editor)
-- Before running: put your email in the "first owner" section at the very bottom,
-- the one you will log in with. That person becomes the owner.
-- ============================================================


-- ---------- people ----------
create table if not exists public.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at   timestamptz not null default now()
);

create table if not exists public.invites (
  email      text primary key,
  role       text not null default 'member' check (role in ('owner','admin','member','viewer')),
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- lab settings (one row) ----------
create table if not exists public.settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- ---------- stocks ----------
create table if not exists public.stocks (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,                -- id from the Claude version (old QR labels)
  stock           text not null,
  line            text,
  name            text,
  category        text,
  common          boolean not null default false,
  generation      text,
  zygosity        text,
  parent_id       uuid references public.stocks(id) on delete set null,
  room            text,
  location        text,
  fert_date       date,
  pil             text,
  ppl             text,
  severity        text,
  count           int check (count >= 0),
  females         int check (females >= 0),
  males           int check (males >= 0),
  keepers         uuid[] not null default '{}',
  fluors          text[] not null default '{}',
  fluor_note      text,
  comments        text,
  status          text not null default 'active' check (status in ('active','archived','deleted')),
  prev_status     text,
  regen_date      date,
  regen_new_stock text,
  deleted_at      timestamptz,
  deleted_by      uuid,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now()
);

-- ---------- crosses (breeding log) ----------
create table if not exists public.crosses (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  stock_id     uuid references public.stocks(id) on delete set null,   -- female parent
  stock2_id    uuid references public.stocks(id) on delete set null,   -- male parent (if a registered stock)
  stock_label  text,
  stock2_label text,
  same_stock   boolean not null default false,
  partner      text,                                                  -- male line not in the register
  date         date not null,
  cross_type   text,
  success      boolean not null default true,
  eggs         int check (eggs >= 0),
  fert_rate    numeric check (fert_rate between 0 and 100),
  quality      smallint check (quality between 1 and 5),
  use          text,
  notes        text,
  plan_id      uuid,
  deleted      boolean not null default false,
  deleted_at   timestamptz,
  deleted_by   uuid,
  by           uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---------- planned crosses ----------
create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  stock_id     uuid references public.stocks(id) on delete set null,
  stock2_id    uuid references public.stocks(id) on delete set null,
  stock_label  text,
  stock2_label text,
  same_stock   boolean not null default false,
  partner      text,
  date         date not null,
  cross_type   text,
  note         text,
  status       text not null default 'planned' check (status in ('planned','done','cancelled')),
  done_date    date,
  done_by      uuid,
  cancelled_by uuid,
  by           uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---------- fish number events ----------
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  stock_id   uuid references public.stocks(id) on delete set null,
  stock_label text,
  date       date not null,
  type       text not null check (type in ('death','cull','procedure','transfer','added','recount')),
  n          int check (n >= 0),
  sex        text check (sex in ('','F','M')),
  before     int,
  after      int,
  ppl        text,
  note       text,
  by         uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- change history (written automatically, read-only) ----------
create table if not exists public.history (
  id       bigint generated always as identity primary key,
  stock_id uuid,
  action   text not null,
  changes  jsonb not null default '{}'::jsonb,
  note     text,
  at       timestamptz not null default now(),
  by       uuid default auth.uid()
);

create index if not exists crosses_stock_idx  on public.crosses(stock_id);
create index if not exists crosses_stock2_idx on public.crosses(stock2_id);
create index if not exists plans_stock_idx    on public.plans(stock_id);
create index if not exists events_stock_idx   on public.events(stock_id);
create index if not exists history_stock_idx  on public.history(stock_id);

-- ---------- role helpers ----------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where user_id = auth.uid()
$$;
create or replace function public.can_read()  returns boolean language sql stable as $$ select public.my_role() is not null $$;
create or replace function public.can_write() returns boolean language sql stable as $$ select public.my_role() in ('owner','admin','member') $$;
create or replace function public.is_admin()  returns boolean language sql stable as $$ select public.my_role() in ('owner','admin') $$;
create or replace function public.is_owner()  returns boolean language sql stable as $$ select public.my_role() = 'owner' $$;

-- Called by the app after login: turns a pending invite into membership.
create or replace function public.claim_invite() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role  text;
begin
  if auth.uid() is null then return null; end if;
  select role into v_role from public.members where user_id = auth.uid();
  if v_role is not null then return v_role; end if;
  select role into v_role from public.invites where lower(email) = v_email;
  if v_role is null then return null; end if;
  insert into public.members (user_id, email, role) values (auth.uid(), v_email, v_role);
  delete from public.invites where lower(email) = v_email;
  return v_role;
end $$;

-- Lets each person set the name shown to the lab.
create or replace function public.set_my_name(p_name text) returns void
language sql security definer set search_path = public as $$
  update public.members set display_name = left(trim(p_name), 60) where user_id = auth.uid()
$$;

-- ---------- automatic timestamps & history ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists stocks_touch on public.stocks;
create trigger stocks_touch before update on public.stocks
  for each row execute function public.touch_updated_at();

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
    when diff ?| array['count','females','males'] and (diff - 'count' - 'females' - 'males') = '{}'::jsonb then 'numbers'
    else 'edited' end;
  insert into public.history (stock_id, action, changes, by) values (new.id, act, diff, auth.uid());
  return new;
end $$;

drop trigger if exists stocks_history on public.stocks;
create trigger stocks_history after insert or update on public.stocks
  for each row execute function public.log_stock_change();

-- ---------- access rules (row level security) ----------
alter table public.members  enable row level security;
alter table public.invites  enable row level security;
alter table public.settings enable row level security;
alter table public.stocks   enable row level security;
alter table public.crosses  enable row level security;
alter table public.plans    enable row level security;
alter table public.events   enable row level security;
alter table public.history  enable row level security;

drop policy if exists members_read  on public.members;
drop policy if exists members_admin on public.members;
create policy members_read  on public.members for select to authenticated using (public.can_read());
create policy members_admin on public.members for all    to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists settings_read  on public.settings;
drop policy if exists settings_write on public.settings;
create policy settings_read  on public.settings for select to authenticated using (public.can_read());
create policy settings_write on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

do $$
declare t text;
begin
  foreach t in array array['stocks','crosses','plans','events'] loop
    execute format('drop policy if exists %1$s_read   on public.%1$s', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_read   on public.%1$s for select to authenticated using (public.can_read())', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_write())', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_write()) with check (public.can_write())', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.is_owner())', t);
  end loop;
end $$;

drop policy if exists history_read on public.history;
create policy history_read on public.history for select to authenticated using (public.can_read());
-- (no insert/update/delete policy on history: only the automatic trigger writes it)

-- ---------- permissions ----------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
grant execute on function public.claim_invite(), public.set_my_name(text), public.my_role() to authenticated;

-- ---------- live updates ----------
do $$
declare t text;
begin
  foreach t in array array['stocks','crosses','plans','events','settings','members'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- first owner ----------
insert into public.invites (email, role)
values (lower('YOUR_EMAIL_HERE'), 'owner')
on conflict (email) do update set role = 'owner';

select 'Setup complete' as status;
