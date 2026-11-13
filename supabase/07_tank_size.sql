-- Fish Tracker update 07 (13 Nov 2026): tank size (1 = single, 2 = double) for tank counts and monthly cost.
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists tank_places int not null default 1 check (tank_places between 1 and 4);
select 'Update 07 applied' as status;
