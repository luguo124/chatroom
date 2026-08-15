// ============================================================
// SupabaseSignaling — Supabase Realtime Broadcast 信令服务
// 复用 MCTier 信令语义（offer / answer / ice-candidate），传输层从 WebSocket 改为 Supabase Realtime Broadcast
// 频道命名：signal:${roomId}，所有房间成员都能收到
// 消息中带 from / to 字段，接收方自行过滤发给自己的消息
// ============================================================

import { supabase } from "../../config/supabase";

/** 信令消息类型（与 MCTier SignalingMessage 对齐） */
export type SignalingType =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "peer-joined"
  | "peer-left"
  | "presence-request"
  | "presence-response";

/** SDP offer/answer 载荷 */
export interface SdpData {
  type: "offer" | "answer";
  sdp: string;
}

/** ICE 候选载荷 */
export interface IceCandidateData {
  candidate: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

/** 信令消息 */
export interface SignalingMessage {
  type: SignalingType;
  /** 发送者钱包地址（小写 0x 字符串） */
  from: string;
  /** 接收者钱包地址（小写 0x 字符串）；broadcast 消息用 '*' */
  to: string;
  /** 关联的房间 ID */
  roomId: string;
  /** offer/answer 时存在 */
  sdp?: SdpData;
  /** ice-candidate 时存在 */
  candidate?: IceCandidateData;
  /** peer-joined/peer-left 时附带发送者昵称（可选） */
  displayName?: string;
  /** 消息时间戳（ms，防重放仅作参考，不强制） */
  ts?: number;
}

/** 消息回调 */
export type SignalingHandler = (msg: SignalingMessage) => void;

/** Realtime Channel 状态 */
export type SignalingState = "idle" | "joining" | "joined" | "error";

const BROADCAST_CHANNEL_PREFIX = "signal:";

/**
 * Supabase Realtime Broadcast 信令客户端
 * 设计：一个房间一个 SupabaseSignaling 实例（一个 channel）
 */
export class SupabaseSignaling {
  private roomId: bigint;
  private localAddress: string; // 小写
  private state: SignalingState = "idle";
  private handlers: Set<SignalingHandler> = new Set();
  private stateHandlers: Set<(state: SignalingState) => void> = new Set();
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private error: string | null = null;
  /** Supabase Presence 当前确认在线的钱包地址 */
  private presentPeers = new Set<string>();

  constructor(roomId: bigint, localAddress: string) {
    this.roomId = roomId;
    this.localAddress = localAddress.toLowerCase();
  }

  /** 当前信令通道状态 */
  getState(): SignalingState {
    return this.state;
  }

  /** 获取错误信息（仅 state === 'error' 时有效） */
  getError(): string | null {
    return this.error;
  }

  /** 房间 ID */
  getRoomId(): bigint {
    return this.roomId;
  }

  /** 注册消息回调 */
  onMessage(handler: SignalingHandler): () => void {
    this.handlers.add(handler);

    // Presence sync 可能发生在 WebRTC handler 注册前（join() 先于 start()）。
    // 新 handler 注册时重放当前在线成员，避免首次上线事件永久丢失。
    for (const peer of this.presentPeers) {
      if (peer !== this.localAddress) {
        handler(this.makePresenceMessage("presence-response", peer));
      }
    }
    return () => this.handlers.delete(handler);
  }

  /** 注册状态变化回调 */
  onStateChange(handler: (state: SignalingState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /**
   * 加入房间频道（订阅 Broadcast）
   * 可安全重复调用（已加入时直接返回）
   */
  async join(): Promise<void> {
    if (this.state === "joined") return;
    if (this.state === "joining") {
      // 等待正在进行的 join 完成
      await new Promise<void>((resolve) => {
        const check = () => {
          const s = this.state as SignalingState;
          if (s === "joined" || s === "error") resolve();
          else setTimeout(check, 100);
        };
        check();
      });
      if (this.state === ("error" as SignalingState)) {
        throw new Error(this.error ?? "加入频道失败");
      }
      return;
    }

    this.setState("joining");
    this.error = null;

    const channelName = `${BROADCAST_CHANNEL_PREFIX}${this.roomId.toString()}`;

    try {
      this.channel = supabase.channel(channelName, {
        config: {
          broadcast: {
            self: false, // 自己不接收自己发的消息（节省带宽）
            ack: true, // 等待服务端 ack，确保信令不丢（否则双方容易互发丢失导致一直离线）
          },
          presence: {
            key: this.localAddress,
          },
        },
      });

      // 监听 Broadcast 消息
      this.channel.on(
        "broadcast",
        { event: "msg" },
        (payload: { payload?: unknown }) => {
          const msg = payload.payload as SignalingMessage | undefined;
          if (!msg || !msg.type || !msg.from || !msg.to) {
            console.warn("[Signaling] 丢弃非法广播消息:", payload);
            return;
          }
          // 只处理发给自己或广播消息
          const mine = msg.to === this.localAddress || msg.to === "*";
          if (!mine) return;
          console.log(
            `[Signaling] 收 ${msg.type} ${msg.from.slice(0, 6)}... → ${msg.to === "*" ? "*" : msg.to.slice(0, 6) + "..."}`,
          );
          this.dispatch(msg);
        },
      );

      // 使用 Supabase 原生 Presence 保留频道内的在线状态。与一次性 Broadcast
      // 不同，新加入或 WebSocket 重连的客户端会收到完整 presenceState 快照。
      this.channel.on("presence", { event: "sync" }, () => {
        this.reconcilePresence();
      });
      this.channel.on("presence", { event: "join" }, () => {
        this.reconcilePresence();
      });
      this.channel.on("presence", { event: "leave" }, () => {
        this.reconcilePresence();
      });

      // 等待订阅成功
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("加入 Supabase Realtime 频道超时（15s）"));
        }, 15000);

        this.channel!.subscribe((status, err) => {
          clearTimeout(timeout);
          if (status === "SUBSCRIBED") {
            resolve();
          } else if (status === "CLOSED" || status === "TIMED_OUT") {
            reject(new Error(`频道订阅失败：${status}`));
          } else if (status === "CHANNEL_ERROR") {
            reject(new Error(`频道错误：${err?.message ?? "未知"}`));
          }
          // JOINING / SUBSCRIBING 忽略，会继续回调
        });
      });

      const trackResult = await this.channel.track({
        address: this.localAddress,
        onlineAt: new Date().toISOString(),
      });
      if (trackResult !== "ok") {
        throw new Error(`Presence 上线登记失败: ${trackResult}`);
      }

      this.setState("joined");
      console.log(`[Signaling] 已加入频道 ${channelName}`);

      // 不再在此处自动发 presence-request：
      // join() 成功返回后，上层必须先 webrtc.start() 注册 handler，
      // 再显式调用 broadcastJoined()，否则对方回复的 presence-response 会被丢弃
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.error = message;
      this.setState("error");
      console.error("[Signaling] 加入频道失败:", e);
      // 清理半初始化资源
      if (this.channel) {
        void supabase.removeChannel(this.channel).catch(() => {});
        this.channel = null;
      }
      throw new Error(message);
    }
  }

  /**
   * 发送 SDP Offer
   */
  async sendOffer(toAddress: string, offer: SdpData): Promise<void> {
    await this.send({
      type: "offer",
      from: this.localAddress,
      to: toAddress.toLowerCase(),
      roomId: this.roomId.toString(),
      sdp: offer,
      ts: Date.now(),
    });
  }

  /**
   * 发送 SDP Answer
   */
  async sendAnswer(toAddress: string, answer: SdpData): Promise<void> {
    await this.send({
      type: "answer",
      from: this.localAddress,
      to: toAddress.toLowerCase(),
      roomId: this.roomId.toString(),
      sdp: answer,
      ts: Date.now(),
    });
  }

  /**
   * 发送 ICE Candidate
   */
  async sendIceCandidate(
    toAddress: string,
    candidate: IceCandidateData,
  ): Promise<void> {
    await this.send({
      type: "ice-candidate",
      from: this.localAddress,
      to: toAddress.toLowerCase(),
      roomId: this.roomId.toString(),
      candidate,
      ts: Date.now(),
    });
  }

  /**
   * 广播 peer-joined（告知其他成员我在线）
   */
  async broadcastJoined(displayName?: string): Promise<void> {
    await this.send({
      type: "peer-joined",
      from: this.localAddress,
      to: "*",
      roomId: this.roomId.toString(),
      displayName,
      ts: Date.now(),
    });
  }

  /**
   * 广播 presence-request（主动询问：谁在？）
   * 在 join() 成功 + 上层 handler 注册完成后显式调用
   */
  async requestPresence(): Promise<void> {
    await this.send({
      type: "presence-request",
      from: this.localAddress,
      to: "*",
      roomId: this.roomId.toString(),
      ts: Date.now(),
    });
  }

  /**
   * 广播 peer-left（告知其他成员我要离开）
   */
  async broadcastLeft(): Promise<void> {
    await this.send({
      type: "peer-left",
      from: this.localAddress,
      to: "*",
      roomId: this.roomId.toString(),
      ts: Date.now(),
    });
  }

  /**
   * 离开频道并清理资源
   */
  async leave(): Promise<void> {
    if (!this.channel) return;
    try {
      await this.broadcastLeft();
    } catch (e) {
      // 离开时的广播失败不阻止清理
      console.warn("[Signaling] 广播 peer-left 失败:", e);
    }
    try {
      await supabase.removeChannel(this.channel);
    } catch (e) {
      console.warn("[Signaling] 移除频道失败:", e);
    }
    this.channel = null;
    this.presentPeers.clear();
    this.handlers.clear();
    this.stateHandlers.clear();
    this.setState("idle");
  }

  // ============ 内部方法 ============

  /** 发送消息到 Broadcast */
  private async send(msg: SignalingMessage): Promise<void> {
    if (this.state !== "joined" || !this.channel) {
      throw new Error(`信令通道未就绪（状态: ${this.state}）`);
    }

    // from 强制修正为本地地址（防止冒充）
    msg.from = this.localAddress;

    const result = await this.channel.send({
      type: "broadcast",
      event: "msg",
      payload: msg,
    });

    const toStr = msg.to === "*" ? "*" : msg.to.slice(0, 6) + "...";
    const fromStr = this.localAddress.slice(0, 6) + "...";
    console.log(
      `[Signaling] 发 ${msg.type} ${fromStr} → ${toStr} result=${result}`,
    );

    // @supabase/realtime-js 返回字符串：'ok' | 'timed out' | 'error'。
    // 旧代码按 { ok: boolean } 读取，导致发送超时/失败被静默当成成功。
    if (result !== "ok") {
      throw new Error(`发送信令消息失败: ${result}`);
    }
  }

  private setState(state: SignalingState): void {
    if (this.state === state) return;
    this.state = state;
    for (const h of this.stateHandlers) {
      try {
        h(state);
      } catch (e) {
        console.error("[Signaling] stateHandler:", e);
      }
    }
  }

  private dispatch(msg: SignalingMessage): void {
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (e) {
        console.error("[Signaling] handler:", e);
      }
    }
  }

  private makePresenceMessage(
    type: "peer-joined" | "peer-left" | "presence-response",
    from: string,
  ): SignalingMessage {
    return {
      type,
      from,
      to: "*",
      roomId: this.roomId.toString(),
      ts: Date.now(),
    };
  }

  /** 将 Supabase Presence 快照转换为现有 WebRTC 信令语义。 */
  private reconcilePresence(): void {
    if (!this.channel) return;

    const state = this.channel.presenceState<Record<string, unknown>>();
    const current = new Set<string>();

    for (const [presenceKey, presences] of Object.entries(state)) {
      const payloadAddress = presences
        .map((presence) =>
          typeof presence.address === "string" ? presence.address : null,
        )
        .find((address): address is string => !!address);
      const address = (payloadAddress ?? presenceKey).toLowerCase();
      if (address && address !== this.localAddress) current.add(address);
    }

    for (const peer of current) {
      if (!this.presentPeers.has(peer)) {
        console.log(`[Signaling] Presence 上线 ${peer.slice(0, 6)}...`);
        this.dispatch(this.makePresenceMessage("peer-joined", peer));
      }
    }

    for (const peer of this.presentPeers) {
      if (!current.has(peer)) {
        console.log(`[Signaling] Presence 离线 ${peer.slice(0, 6)}...`);
        this.dispatch(this.makePresenceMessage("peer-left", peer));
      }
    }

    this.presentPeers = current;
  }
}
