// ============================================================
// SupabaseSignaling 单元测试（mock Supabase RealtimeChannel）
// ============================================================

import { describe, it, expect, beforeEach, vi, Mock } from "vitest";
import { SupabaseSignaling } from "./SupabaseSignaling";
import { supabase } from "../../config/supabase";

// 构造一个最小可用的 mock channel（不 spread，保持引用一致以便断言计数）
type BroadcastCb = (payload: { payload: unknown; event: string }) => void;
type ChannelCb = (payload: unknown) => void;
type MockChannel = {
  listeners: Array<{
    type: string;
    filter: { event?: string };
    cb: ChannelCb;
  }>;
  subscribeCalls: number;
  unsubscribeCalls: number;
  subscribed: boolean;
  sendArgs: unknown[];
  trackArgs: unknown[];
  presenceStateData: Record<string, Array<Record<string, unknown>>>;
  lastSubscribeStatus?: string;
  on: (type: string, filter: unknown, cb: ChannelCb) => void;
  subscribe: (cb: (status: string) => void) => void;
  unsubscribe: () => Promise<void>;
  send: (args: unknown) => Promise<"ok">;
  track: (args: unknown) => Promise<"ok">;
  presenceState: () => Record<string, Array<Record<string, unknown>>>;
  _emit: (event: string, payload: unknown) => void;
  _emitPresence: (event: "sync" | "join" | "leave") => void;
  _setPresence: (state: Record<string, Array<Record<string, unknown>>>) => void;
};

function makeMockChannel(): MockChannel {
  const ch: MockChannel = {
    listeners: [],
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    subscribed: false,
    sendArgs: [],
    trackArgs: [],
    presenceStateData: {},
    on(type, filter, cb) {
      ch.listeners.push({ type, filter: filter as { event?: string }, cb });
    },
    subscribe(cb) {
      ch.subscribeCalls += 1;
      setTimeout(() => {
        ch.subscribed = true;
        cb?.("SUBSCRIBED");
        ch.lastSubscribeStatus = "SUBSCRIBED";
      }, 0);
    },
    async unsubscribe() {
      ch.unsubscribeCalls += 1;
      ch.subscribed = false;
    },
    async send(args) {
      ch.sendArgs.push(args);
      return "ok";
    },
    async track(args) {
      ch.trackArgs.push(args);
      return "ok";
    },
    presenceState() {
      return ch.presenceStateData;
    },
    _emit(event, payload) {
      for (const l of ch.listeners) {
        if (
          l.type === "broadcast" &&
          (!l.filter.event || l.filter.event === event)
        ) {
          (l.cb as BroadcastCb)({ event, payload });
        }
      }
    },
    _emitPresence(event) {
      for (const l of ch.listeners) {
        if (l.type === "presence" && l.filter.event === event) l.cb({});
      }
    },
    _setPresence(state) {
      ch.presenceStateData = state;
    },
  };
  return ch;
}

describe("SupabaseSignaling", () => {
  const ROOM_ID = 123n;
  const local = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let mockChannelFn: Mock;
  let mockRemoveChannel: Mock;
  let ch: ReturnType<typeof makeMockChannel>;

  beforeEach(() => {
    ch = makeMockChannel();
    mockChannelFn = vi.fn(() => ch);
    mockRemoveChannel = vi.fn(async () => {});
    // 替换 supabase 单例的 channel/removeChannel 方法（monkeypatch 测试用）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).channel = mockChannelFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).removeChannel = mockRemoveChannel;
  });

  function makeSignaling(address: string = local) {
    return new SupabaseSignaling(ROOM_ID, address);
  }

  describe("join()", () => {
    it("应通过 supabase.channel 创建 signal:${roomId} 频道并订阅", async () => {
      const s = makeSignaling();
      await s.join();
      expect(mockChannelFn).toHaveBeenCalledTimes(1);
      expect(mockChannelFn.mock.calls[0][0]).toBe("signal:123");
      expect((ch as unknown as MockChannel).subscribeCalls).toBe(1);
      expect(ch.trackArgs).toEqual([
        expect.objectContaining({ address: local }),
      ]);
      expect(s.getState()).toBe("joined");
    });

    it("重复 join 应忽略并发加入", async () => {
      const s = makeSignaling();
      const p1 = s.join();
      const p2 = s.join();
      await Promise.all([p1, p2]);
      expect((ch as unknown as MockChannel).subscribeCalls).toBe(1);
    });
  });

  describe("onMessage 回调", () => {
    it("接收到 broadcast msg 事件应分发给 onMessage handlers", async () => {
      const s = makeSignaling();
      await s.join();
      const handler = vi.fn();
      s.onMessage(handler);

      const msg = {
        type: "offer" as const,
        from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        to: local,
        sdp: { type: "offer" as const, sdp: "v=0\r\n..." },
      };
      (ch as ReturnType<typeof makeMockChannel>)._emit("msg", msg);
      await new Promise((r) => setTimeout(r, 5));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({
        type: "offer",
        to: local,
      });
    });

    it("应向晚注册的 handler 重放 Presence 中已在线的成员", async () => {
      const peer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const s = makeSignaling();
      await s.join();
      ch._setPresence({ [peer]: [{ address: peer }] });
      ch._emitPresence("sync");

      const handler = vi.fn();
      s.onMessage(handler);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "presence-response",
          from: peer,
          roomId: ROOM_ID.toString(),
        }),
      );
    });

    it("Presence 成员离开时应分发 peer-left", async () => {
      const peer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const s = makeSignaling();
      await s.join();
      const handler = vi.fn();
      s.onMessage(handler);

      ch._setPresence({ [peer]: [{ address: peer }] });
      ch._emitPresence("sync");
      ch._setPresence({});
      ch._emitPresence("sync");

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "peer-left", from: peer }),
      );
    });
  });

  describe("sendOffer/sendAnswer/sendIceCandidate", () => {
    it('sendOffer 应发送 {type:broadcast,event:msg,payload:{type:"offer",...}}', async () => {
      const s = makeSignaling();
      await s.join();
      // 等待广播 presence-request 发送完成
      await new Promise((r) => setTimeout(r, 5));
      const sendCountBefore = ch.sendArgs.length;
      await s.sendOffer("0xbcd", { type: "offer", sdp: "v=0" });
      const args = ch.sendArgs[sendCountBefore] as {
        type: string;
        event: string;
        payload: unknown;
      };
      expect(args.type).toBe("broadcast");
      expect(args.event).toBe("msg");
      expect(args.payload).toMatchObject({
        type: "offer",
        to: "0xbcd",
        from: local,
        sdp: { type: "offer", sdp: "v=0" },
      });
    });
  });
});
