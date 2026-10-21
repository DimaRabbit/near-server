-- NEAR city bulletin board (vacancies / resumes / portfolio)
-- Run in Supabase SQL Editor: project uaxanaiurpgocfqmpvwm

create table if not exists public.bulletin_posts (
  id text primary key,
  kind text not null check (kind in ('vacancy', 'resume', 'portfolio')),
  title text not null,
  body text not null default '',
  link_url text not null default '',
  author_name text not null,
  author_session_id integer not null default 0,
  author_user_id uuid null,
  created_unix bigint not null
);

create table if not exists public.bulletin_replies (
  id text primary key,
  post_id text not null references public.bulletin_posts (id) on delete cascade,
  from_name text not null,
  from_session_id integer not null default 0,
  from_user_id uuid null,
  text text not null,
  created_unix bigint not null
);

create index if not exists bulletin_posts_created_idx
  on public.bulletin_posts (created_unix desc);

create index if not exists bulletin_replies_post_idx
  on public.bulletin_replies (post_id);

alter table public.bulletin_posts enable row level security;
alter table public.bulletin_replies enable row level security;

-- Public read (clients may later fetch directly; writes go through near-server service role).
drop policy if exists bulletin_posts_select_public on public.bulletin_posts;
create policy bulletin_posts_select_public
  on public.bulletin_posts for select
  using (true);

drop policy if exists bulletin_replies_select_public on public.bulletin_replies;
create policy bulletin_replies_select_public
  on public.bulletin_replies for select
  using (true);

-- No INSERT/UPDATE/DELETE policies for anon/authenticated:
-- near-server uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
