// ============================================================
// Edge Function: fetch-offline
// 接收方拉取自己的离线密文（带钱包签名验证）
// 安全：验证 recipientSignature 后用 service_role key 查询并删除
// 注意：使用 ethers.js v5.7.2 替代 viem，解决 Deno 兼容性问题
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { utils } from 'https://esm.sh/ethers@5.7.2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface FetchRequest {
  recipientAddress: string;
  roomId?: string;
  timestamp: number;
  recipientSignature: string; // 对 `fetch:${recipientAddress}:${timestamp}` 的 personal_sign 签名
}

interface OfflineMessage {
  id: string;
  room_id: string;
  sender_address: string;
  recipient_address: string;
  ciphertext: string;
  created_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body: FetchRequest = await req.json();
    const { recipientAddress, roomId, timestamp, recipientSignature } = body;

    if (!recipientAddress || !timestamp || !recipientSignature) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 验证钱包签名（使用 ethers.js utils.verifyMessage）
    const message = `fetch:${recipientAddress}:${timestamp}`;
    let recovered: string;
    try {
      recovered = utils.verifyMessage(message, recipientSignature);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ error: 'Signature verification failed: ' + errMsg }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (recovered.toLowerCase() !== recipientAddress.toLowerCase()) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 防重放
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ error: 'Timestamp expired' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let query = supabase
      .from('offline_messages')
      .select('id, room_id, sender_address, recipient_address, ciphertext, created_at')
      .eq('recipient_address', recipientAddress.toLowerCase())
      .order('created_at', { ascending: true });

    if (roomId) {
      query = query.eq('room_id', roomId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('查询离线消息失败:', error);
      return new Response(JSON.stringify({ error: 'Failed to fetch messages' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messages = (data ?? []) as OfflineMessage[];

    // 拉取后删除已读记录
    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const { error: deleteError } = await supabase
        .from('offline_messages')
        .delete()
        .in('id', ids);

      if (deleteError) {
        console.error('删除已拉取消息失败:', deleteError);
      }
    }

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('fetch-offline 异常:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
