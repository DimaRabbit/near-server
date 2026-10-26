-- NEAR office whiteboard notes + freehand strokes (persist across Render restarts)
-- Run in Supabase SQL Editor after office_board.sql

create table if not exists public.office_wb_notes (
  office_key text not null,
  id text not null,
  author text not null default '',
  color int not null default 0,
  body text not null default '',
  updated_unix bigint not null default 0,
  primary key (office_key, id)
);

create table if not exists public.office_wb_strokes (
  office_key text not null,
  id text not null,
  author text not null default '',
  color int not null default 0,
  points text not null default '',
  updated_unix bigint not null default 0,
  primary key (office_key, id)
);

create index if not exists office_wb_notes_key_idx
  on public.office_wb_notes (office_key);

create index if not exists office_wb_strokes_key_idx
  on public.office_wb_strokes (office_key);

create index if not exists office_wb_strokes_author_idx
  on public.office_wb_strokes (office_key, author);

alter table public.office_wb_notes enable row level security;
alter table public.office_wb_strokes enable row level security;

drop policy if exists office_wb_notes_select_public on public.office_wb_notes;
create policy office_wb_notes_select_public
  on public.office_wb_notes for select
  using (true);

drop policy if exists office_wb_strokes_select_public on public.office_wb_strokes;
create policy office_wb_strokes_select_public
  on public.office_wb_strokes for select
  using (true);
