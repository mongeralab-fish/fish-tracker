-- Fish Tracker update 05 (12 Nov 2026): close a tank (e.g. whole tank culled) while keeping all its records.
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists closed_reason text;
alter table public.stocks add column if not exists closed_date   date;
alter table public.stocks add column if not exists closed_note   text;
select 'Update 05 applied' as status;
