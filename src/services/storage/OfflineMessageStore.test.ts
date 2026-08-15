// ============================================================
// OfflineMessageStore 单元测试（mock fetch + 注入 signer）
// ============================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OfflineMessageStore } from './OfflineMessageStore';

describe('OfflineMessageStore', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.unstubAllGlobals();
    // 重置 signer 状态：通过赋值为 null (私有静态)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OfflineMessageStore as any).signer = null;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  describe('未注入 signer', () => {
    it('store 抛错：未注入签名函数', async () => {
      await expect(
        OfflineMessageStore.store({
          roomId: 1n,
          senderAddress: '0xa' as `0x${string}`,
          recipientAddress: '0xb' as `0x${string}`,
          ciphertext: 'x',
        })
      ).rejects.toThrow(/未注入签名函数/);
    });
  });

  describe('store', () => {
    it('应调用签名并 POST /functions/v1/store-offline，返回 true', async () => {
      const signer = vi.fn().mockResolvedValue('0xsig123' as `0x${string}`);
      OfflineMessageStore.setSigner(signer);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const res = await OfflineMessageStore.store({
        roomId: 7n,
        senderAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`,
        recipientAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`,
        ciphertext: 'CIPHERTEXT',
      });

      expect(res).toBe(true);
      expect(signer).toHaveBeenCalledTimes(1);
      // 签名原文格式：`${roomIdStr}:${recipientAddressLower}:${timestamp}`
      const signed = signer.mock.calls[0][0] as string;
      expect(signed).toMatch(/^7:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:\d+$/);

      // fetch 调用
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('/functions/v1/store-offline');
      const body = JSON.parse(opts.body);
      expect(body.ciphertext).toBe('CIPHERTEXT');
      expect(body.senderSignature).toBe('0xsig123');
      expect(body.roomId).toBe('7');
    });
  });

  describe('fetch', () => {
    it('应签名 + POST fetch-offline，解析 messages 字段', async () => {
      const signer = vi.fn().mockResolvedValue('0xsig_fetch' as `0x${string}`);
      OfflineMessageStore.setSigner(signer);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'uuid-1',
              room_id: '9',
              sender_address: '0xaaaa',
              recipient_address: '0xbbbb',
              ciphertext: 'C1',
              created_at: '2025-01-01T00:00:00Z',
            },
          ],
        }),
      });

      const list = await OfflineMessageStore.fetch({
        recipientAddress: '0xbbbb' as `0x${string}`,
        roomId: 9n,
      });

      expect(signer).toHaveBeenCalledTimes(1);
      const signed = signer.mock.calls[0][0] as string;
      expect(signed).toMatch(/^fetch:0xbbbb:\d+$/);

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'uuid-1',
        roomId: '9',
        ciphertext: 'C1',
      });
    });
  });
});
