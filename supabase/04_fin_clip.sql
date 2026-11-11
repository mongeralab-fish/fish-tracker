-- Fish Tracker update 04 (11 Nov 2026): fin clipping (tick on the stock + event with actual severity, for the ROP).
-- Run once in Supabase › SQL Editor.
alter table public.stocks add column if not exists fin_clipped   boolean not null default false;
alter table public.stocks add column if not exists fin_clip_date date;
alter table public.stocks add column if not exists fin_clip_n    int check (fin_clip_n >= 0);
alter table public.events add column if not exists actual_severity text;
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('finclip','death','cull','procedure','transfer','added','recount'));
select 'Update 04 applied' as status;
