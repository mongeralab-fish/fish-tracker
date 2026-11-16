-- Fish Tracker update 09 (16 Nov 2026): facility rules
--  • PPL protocol number on each tank   • genobox day counter   • facility propagation requests on plans
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists ppl_protocol  text;
alter table public.stocks add column if not exists genobox_since date;
alter table public.plans  add column if not exists facility boolean not null default false;


-- Room A was renamed Room D: move any tank still recorded in "Room A".
update public.stocks set room = 'Room D' where trim(lower(room)) in ('room a', 'a');
select 'Update 09 applied' as status;
