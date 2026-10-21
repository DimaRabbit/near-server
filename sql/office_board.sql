-- NEAR office Kanban + day reports (persist across Render restarts)
-- Run in Supabase SQL Editor after bulletin.sql

create table if not exists public.office_board_cards (
  office_key text not null,
  id text not null,
  column_id text not null check (column_id in ('todo', 'doing', 'done')),
  author text not null default '',
  due_date text not null default '',
  body text not null default '',
  updated_unix bigint not null default 0,
  primary key (office_key, id)
);

create table if not exists public.office_day_reports (
  office_key text not null,
  author text not null,
  date_ymd text not null,
  body text not null default '',
  updated_unix bigint not null default 0,
  primary key (office_key, author, date_ymd)
);

create index if not exists office_board_cards_key_idx
  on public.office_board_cards (office_key);

create index if not exists office_day_reports_key_idx
  on public.office_day_reports (office_key, date_ymd);

alter table public.office_board_cards enable row level security;
alter table public.office_day_reports enable row level security;

drop policy if exists office_board_cards_select_public on public.office_board_cards;
create policy office_board_cards_select_public
  on public.office_board_cards for select
  using (true);

drop policy if exists office_day_reports_select_public on public.office_day_reports;
create policy office_day_reports_select_public
  on public.office_day_reports for select
  using (true);
