// ============================================================
// Edge Function: store-offline
// 发送方将离线密文暂存到 Supabase（带钱包签名验证）
// 安全：验证 senderSignature 后用 service_role key 写入
// 注意：使用 ethers.js v5.7.2 替代 viem，解决 Deno 兼容性问题
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { utils } from 'https://esm.sh/ethers@5.7.2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface StoreRequest {
  senderAddress: string;
  recipientAddress: string;
  roomId: string;
  ciphertext: string;
  timestamp: number;
  senderSignature: string; // 对 `${roomId}:${recipientAddress}:${timestamp}` 的 personal_sign 签名
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body: StoreRequest = await req.json();
    const { senderAddress, recipientAddress, roomId, ciphertext, timestamp, senderSignature } = body;

    if (!senderAddress || !recipientAddress || !roomId || !ciphertext || !timestamp || !senderSignature) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 验证钱包签名（使用 ethers.js utils.verifyMessage）
    const message = `${roomId}:${recipientAddress}:${timestamp}`;
    let recovered: string;
    try {
      recovered = utils.verifyMessage(message, senderSignature);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ error: 'Signature verification failed: ' + errMsg }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (recovered.toLowerCase() !== senderAddress.toLowerCase()) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 防重放：timestamp 必须在 5 分钟内
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ error: 'Timestamp expired' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { error } = await supabase.from('offline_messages').insert({
      room_id: roomId,
      sender_address: senderAddress.toLowerCase(),
      recipient_address: recipientAddress.toLowerCase(),
      ciphertext,
    });

    if (error) {
      console.error('写入离线消息失败:', error);
      return new Response(JSON.stringify({ error: 'Failed to store message' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('store-offline 异常:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
