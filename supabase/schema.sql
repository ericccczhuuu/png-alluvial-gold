-- PNG 砂金项目台 · Supabase 建表与权限
-- 用法：Supabase 控制台 → SQL Editor → 粘贴整份 → Run。可重复运行。
-- 权限模型：只有 members 表里的人能读；role = 'editor' 的人才能写。未登录的人什么数据都读不到。

create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('editor','viewer'))
);

create table if not exists public.docs (
  id text primary key default gen_random_uuid()::text,
  collection text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists docs_collection_idx on public.docs (collection, created_at);

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.members where user_id = auth.uid()) $$;
create or replace function public.is_editor() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.members where user_id = auth.uid() and role = 'editor') $$;

create or replace function public.docs_touch() returns trigger language plpgsql as
  $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.docs_touch();

-- 局部更新（页面里改任务状态用）；security invoker，所以仍受行级安全约束
create or replace function public.docs_patch(p_id text, p_patch jsonb) returns void
  language sql security invoker as
  $$ update public.docs set data = data || p_patch where id = p_id $$;

alter table public.members enable row level security;
alter table public.docs enable row level security;

drop policy if exists members_self on public.members;
create policy members_self on public.members for select using (user_id = auth.uid());

drop policy if exists docs_read on public.docs;
create policy docs_read   on public.docs for select using (public.is_member());
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert with check (public.is_editor());
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update using (public.is_editor()) with check (public.is_editor());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete using (public.is_editor());

-- 实时同步（删除事件需要完整旧行才能按 collection 过滤）
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 文件存储：私有桶，单文件 20 MB
insert into storage.buckets (id, name, public, file_size_limit)
values ('assets', 'assets', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists assets_read on storage.objects;
create policy assets_read   on storage.objects for select using (bucket_id = 'assets' and public.is_member());
drop policy if exists assets_insert on storage.objects;
create policy assets_insert on storage.objects for insert with check (bucket_id = 'assets' and public.is_editor());
drop policy if exists assets_delete on storage.objects;
create policy assets_delete on storage.objects for delete using (bucket_id = 'assets' and public.is_editor());

-- ===== 链接密钥访问（不用登录）=====
-- 用 ?k=密钥 打开网站的人，浏览器会在每个请求里带 x-access-key 头；数据库只存密钥的 SHA-256 哈希。
-- 添加密钥（把 '你的密钥' 换成一串足够长的随机字符，例如 openssl rand -hex 16 的输出）：
--   insert into public.access_keys (key_hash, role, note)
--   values (encode(extensions.digest('你的密钥', 'sha256'), 'hex'), 'editor', '主链接');
-- 撤销密钥：delete from public.access_keys where note = '主链接';
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.access_keys (
  key_hash text primary key,
  role text not null check (role in ('editor','viewer')),
  note text
);
alter table public.access_keys enable row level security;  -- 不建任何策略：网页端无法直接读写

create or replace function public.key_role() returns text
  language sql stable security definer set search_path = public, extensions as
  $$ select role from public.access_keys
     where key_hash = encode(digest(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-access-key', ''), 'sha256'), 'hex')
     limit 1 $$;

create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public as
  $$ select case
       when exists (select 1 from public.members where user_id = auth.uid() and role = 'editor') or public.key_role() = 'editor' then 'editor'
       when exists (select 1 from public.members where user_id = auth.uid()) or public.key_role() = 'viewer' then 'viewer'
     end $$;

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.my_role() is not null $$;
create or replace function public.is_editor() returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.my_role() = 'editor' $$;

revoke all on function public.key_role() from public, anon, authenticated;
grant execute on function public.my_role() to anon, authenticated;
