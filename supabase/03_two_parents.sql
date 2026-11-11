-- Fish Tracker update 03 (11 Nov 2026): two parents per stock (♀ and ♂), a note for parents
-- outside the register, and a link to the cross the stock was born from.
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists parent2_id    uuid references public.stocks(id) on delete set null;
alter table public.stocks add column if not exists parent_note   text;
alter table public.stocks add column if not exists from_cross_id uuid references public.crosses(id) on delete set null;
select 'Update 03 applied' as status;
