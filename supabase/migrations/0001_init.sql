-- ============================================================
-- MonadChat 离线消息表初始化
-- 安全模型：RLS 启用 + 默认拒绝 anon 直接读写
-- 仅 Edge Function（service_role key + 钱包签名验证）可访问
-- ============================================================

-- 离线加密消息暂存表（仅存密文，无法解密）
create table if not exists public.offline_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  sender_address text not null,      -- 钱包地址（0x...）
  recipient_address text not null,   -- 收件人钱包地址（0x...）
  ciphertext text not null,          -- AES-GCM 加密后的密文（base64）
  created_at timestamptz not null default now()
);

-- 查询索引：按收件人 + 创建时间（拉取离线消息时用）
create index if not exists idx_offline_messages_recipient_created
  on public.offline_messages (recipient_address, created_at desc);

-- 启用 Row Level Security（默认拒绝 anon 直接读写）
alter table public.offline_messages enable row level security;

-- 不创建任何 Policy：anon key 无法直接读写，必须通过 Edge Function 验签后用 service_role 访问

-- ============================================================
-- pg_cron: 每小时清理 24 小时前的过期密文
-- ============================================================

create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'cleanup-expired-offline-messages',
  '0 * * * *',
  $$
    delete from public.offline_messages
    where created_at < now() - interval '24 hours';
  $$
);
