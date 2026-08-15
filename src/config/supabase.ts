import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[Supabase] 缺少环境变量 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY，请在 .env 中配置'
  );
}

// 前端使用的 Supabase 客户端（anon key，仅 Realtime Broadcast + 调用 Edge Function）
// 离线消息表的直接读写被 RLS 拒绝，必须通过 Edge Function 验签后用 service_role 访问
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});
