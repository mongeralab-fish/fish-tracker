-- Fish Tracker update 08 (16 Nov 2026): merge tanks (link from the emptied tank to the receiving one).
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists merged_into uuid references public.stocks(id) on delete set null;
select 'Update 08 applied' as status;
