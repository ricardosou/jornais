create table if not exists covers (
  slug         text primary key,
  image_url    text not null,
  refreshed_at timestamptz not null default now()
);

alter table covers enable row level security;

-- Anyone can read (serve function uses anon key for lookups)
create policy "Public read" on covers
  for select using (true);
