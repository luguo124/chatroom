// ============================================================
// OfflineMessageStore — 离线消息暂存（Supabase Edge Function）
// 对应：
//   - supabase/functions/store-offline（写入，需 sender 签名）
//   - supabase/functions/fetch-offline（拉取+删除，需 recipient 签名）
//
// 签名规则（与 Edge Function 约定一致，见 0.2.4 / 0.2.5 实现）：
//   store 签名原文： `${roomId}:${recipientAddress}:${timestamp}`
//   fetch 签名原文： `fetch:${recipientAddress}:${timestamp}`
//   使用 MetaMask personal_sign（钱包地址为发送方/接收方地址）
// ============================================================

import { supabase } from '../../config/supabase';

/** 拉取到的离线密文 */
export interface OfflineMessage {
  id: string;
  roomId: string;
  senderAddress: string;
  recipientAddress: string;
  /** E2EE 密文 payload（JSON 字符串） */
  ciphertext: string;
  /** Supabase 创建时间（ISO 字符串） */
  createdAt: string;
}

/**
 * 签名提供者
 * 由上层注入（使用 WalletService.signMessage），避免此模块直接依赖 WalletService
 */
export type SignFunction = (
  message: string,
  address: `0x${string}`
) => Promise<`0x${string}`>;

const STORE_FUNC_PATH = '/functions/v1/store-offline';
const FETCH_FUNC_PATH = '/functions/v1/fetch-offline';

/**
 * 离线消息暂存服务
 * 使用前必须先调用 setSigner 注入 MetaMask personal_sign 函数
 */
export class OfflineMessageStore {
  private static signer: SignFunction | null = null;

  /**
   * 注入签名函数（来自 WalletService）
   * MVP 阶段仅支持 MetaMask personal_sign
   */
  static setSigner(signer: SignFunction): void {
    OfflineMessageStore.signer = signer;
  }

  /**
   * 暂存单条离线消息（发送给某离线成员的密文）
   * @returns true = 暂存成功
   */
  static async store(args: {
    roomId: bigint;
    senderAddress: `0x${string}`;
    recipientAddress: `0x${string}`;
    ciphertext: string;
  }): Promise<boolean> {
    if (!OfflineMessageStore.signer) {
      throw new Error('OfflineMessageStore: 未注入签名函数，请先调用 setSigner()');
    }
    const { roomId, senderAddress, recipientAddress, ciphertext } = args;
    const timestamp = Date.now();
    const roomIdStr = roomId.toString();

    const signMessage = `${roomIdStr}:${recipientAddress.toLowerCase()}:${timestamp}`;
    let signature: `0x${string}`;
    try {
      signature = await OfflineMessageStore.signer(signMessage, senderAddress);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`暂存离线消息签名被拒绝: ${message}`);
    }

    const url = OfflineMessageStore.buildEdgeFunctionUrl(STORE_FUNC_PATH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderAddress: senderAddress.toLowerCase(),
        recipientAddress: recipientAddress.toLowerCase(),
        roomId: roomIdStr,
        ciphertext,
        timestamp,
        senderSignature: signature,
      }),
    });

    if (!resp.ok) {
      let errorText = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data?.error) errorText = data.error;
      } catch {}
      console.error('[OfflineStore] store 失败:', errorText);
      throw new Error(`暂存离线消息失败: ${errorText}`);
    }

    return true;
  }

  /**
   * 拉取属于自己的离线消息
   * @param roomId 可选，限定某房间
   * @returns 密文数组，按创建时间升序
   */
  static async fetch(args: {
    recipientAddress: `0x${string}`;
    roomId?: bigint;
  }): Promise<OfflineMessage[]> {
    if (!OfflineMessageStore.signer) {
      throw new Error('OfflineMessageStore: 未注入签名函数，请先调用 setSigner()');
    }
    const { recipientAddress, roomId } = args;
    const timestamp = Date.now();

    const signMessage = `fetch:${recipientAddress.toLowerCase()}:${timestamp}`;
    let signature: `0x${string}`;
    try {
      signature = await OfflineMessageStore.signer(signMessage, recipientAddress);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`拉取离线消息签名被拒绝: ${message}`);
    }

    const body: Record<string, unknown> = {
      recipientAddress: recipientAddress.toLowerCase(),
      timestamp,
      recipientSignature: signature,
    };
    if (roomId !== undefined) body.roomId = roomId.toString();

    const url = OfflineMessageStore.buildEdgeFunctionUrl(FETCH_FUNC_PATH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      let errorText = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data?.error) errorText = data.error;
      } catch {}
      console.error('[OfflineStore] fetch 失败:', errorText);
      throw new Error(`拉取离线消息失败: ${errorText}`);
    }

    const data = await resp.json();
    const rawList: Array<{
      id: string;
      room_id: string;
      sender_address: string;
      recipient_address: string;
      ciphertext: string;
      created_at: string;
    }> = data.messages ?? [];

    return rawList.map((m) => ({
      id: m.id,
      roomId: m.room_id,
      senderAddress: m.sender_address,
      recipientAddress: m.recipient_address,
      ciphertext: m.ciphertext,
      createdAt: m.created_at,
    }));
  }

  // ============ 内部辅助 ============

  /**
   * 拼接完整 Edge Function URL
   * 优先从 supabase client 的 rest url 推断 Supabase 项目 URL
   */
  private static buildEdgeFunctionUrl(path: string): string {
    // 从 anonKey 或 supabaseUrl 环境变量推断
    const base =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any).rest?.url?.replace('/rest/v1', '') ??
      import.meta.env.VITE_SUPABASE_URL;

    if (!base) throw new Error('无法推断 Supabase URL');
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
