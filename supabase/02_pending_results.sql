-- Fish Tracker update 02 (11 Nov 2026): allow crosses to be saved before the result is known
-- ("Waiting for result"). Run once in Supabase › SQL Editor.
alter table public.crosses alter column success drop not null;
select 'Update 02 applied' as status;
