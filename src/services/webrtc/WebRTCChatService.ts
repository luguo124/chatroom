// ============================================================
// WebRTCChatService — 浏览器原生 WebRTC Data Channel 聊天传输
// 职责：
//   - 维护 <peerAddress → RTCPeerConnection> 映射
//   - 管理 DataChannel（ordered reliable, ordered: true）
//   - 接 SupabaseSignaling 做 SDP/ICE 交换
//   - 处理 ICE 连接状态变化 + 断线重连
//   - 发送密文（E2EEService 在上层已加密好的 payload）
// ============================================================

import { getIceServers } from "../../config/turn";
import {
  SupabaseSignaling,
  type SignalingMessage,
  type SdpData,
  type IceCandidateData,
} from "../signaling/SupabaseSignaling";

/** 连接状态 */
export type PeerConnectionState =
  "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

/** 单个对端的连接信息 */
interface PeerEntry {
  peerAddress: string;
  peerPublicKey?: Uint8Array; // X25519 公钥（从合约读取后设置）
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** 收到的远程 SDP 是否已设置（用于判断 ICE 候选是否可直接 addIceCandidate） */
  remoteSdpSet: boolean;
  /** 在 remoteSdpSet=true 前收集到的 ICE 候选队列 */
  iceQueue: RTCIceCandidate[];
  /** 当前状态 */
  state: PeerConnectionState;
  /** 正在协商中（防止 SDP glare） */
  isNegotiating: boolean;
  /** 创建时间，用于 connectionState 超时判定 */
  createdAt: number;
  /** 失败重连次数 */
  retryCount: number;
}

/** 已收到的聊天消息（供上层订阅） */
export interface ChatMessageReceived {
  from: string;
  payload: string; // 密文 payload，由上层 E2EEService 解密
  receivedAt: number;
}

/** 消息发送结果 */
export interface SendResult {
  peer: string;
  /** true = 已通过 DataChannel 送达, false = 对端离线，已交给 OfflineMessageStore（若提供） */
  delivered: boolean;
  error?: string;
}

/**
 * WebRTC 聊天服务
 * 使用方式：
 *   const svc = new WebRTCChatService(signaling, myAddress);
 *   svc.onPeerStateChanged(cb); svc.onMessage(cb);
 *   await svc.connectWithPeers([peerAddress], peerPublicKeys);
 *   await svc.send(ciphertext, targetPeerAddress);
 */
export class WebRTCChatService {
  private static readonly CONNECTION_TIMEOUT_MS = 20_000;
  private signaling: SupabaseSignaling;
  private localAddress: string; // 小写钱包地址

  // 对端映射：peerAddress (lowercase) -> PeerEntry
  private peers = new Map<string, PeerEntry>();

  // 状态/消息回调
  private messageHandlers = new Set<(msg: ChatMessageReceived) => void>();
  private stateHandlers = new Set<
    (peer: string, state: PeerConnectionState) => void
  >();
  private errorHandlers = new Set<(peer: string, error: string) => void>();

  // 对端公钥缓存（由上层 setPeerPublicKey 写入，用于离线消息层选择 E2EE 密钥）
  private peerPublicKeys = new Map<string, Uint8Array>();

  // 离线消息暂存回调（若上层注入，send 失败时调用）
  private offlineStore?: (args: {
    peerAddress: string;
    ciphertext: string;
  }) => Promise<boolean>;

  private cleanupSignalingHandler: (() => void) | null = null;

  constructor(signaling: SupabaseSignaling, localAddress: string) {
    this.signaling = signaling;
    this.localAddress = localAddress.toLowerCase();
  }

  /**
   * 启动服务：订阅信令消息（由 SupabaseSignaling 分发）
   * 必须在 connectWithPeers 之前调用
   */
  start(): void {
    if (this.cleanupSignalingHandler) return; // 已启动
    this.cleanupSignalingHandler = this.signaling.onMessage(
      (msg) => void this.handleSignalingMessage(msg),
    );
  }

  /**
   * 停止服务：清理所有 PeerConnection，取消订阅信令
   */
  async stop(): Promise<void> {
    // 清理所有对端
    for (const peer of this.peers.values()) {
      try {
        if (peer.dc && peer.dc.readyState === "open") peer.dc.close();
      } catch {
        /* ignore */
      }
      try {
        peer.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.peerPublicKeys.clear();

    // 取消信令订阅
    if (this.cleanupSignalingHandler) {
      this.cleanupSignalingHandler();
      this.cleanupSignalingHandler = null;
    }
  }

  // ============ 回调注册 ============

  onMessage(handler: (msg: ChatMessageReceived) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onPeerStateChanged(
    handler: (peer: string, state: PeerConnectionState) => void,
  ): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onError(handler: (peer: string, error: string) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * 注入离线消息暂存回调
   * send 时 DataChannel 未连接 → 调用此回调，返回 true 表示暂存成功
   */
  setOfflineStore(
    fn: (args: { peerAddress: string; ciphertext: string }) => Promise<boolean>,
  ): void {
    this.offlineStore = fn;
  }

  /**
   * 设置对端 X25519 公钥（从合约读取后传入）
   */
  setPeerPublicKey(peerAddress: string, pk: Uint8Array): void {
    this.peerPublicKeys.set(peerAddress.toLowerCase(), pk);
  }

  getPeerPublicKey(peerAddress: string): Uint8Array | undefined {
    return this.peerPublicKeys.get(peerAddress.toLowerCase());
  }

  /** 获取某对端当前连接状态 */
  getPeerState(peerAddress: string): PeerConnectionState | "unknown" {
    return this.peers.get(peerAddress.toLowerCase())?.state ?? "unknown";
  }

  /** 获取所有在线（connected）对端 */
  getConnectedPeers(): string[] {
    return Array.from(this.peers.values())
      .filter((p) => p.state === "connected")
      .map((p) => p.peerAddress);
  }

  // ============ 连接管理 ============

  /**
   * 与一批对端建立 DataChannel 连接
   * 使用字典序防双方同时发 Offer：localAddress > peerAddress 时主动发 Offer
   */
  async connectWithPeers(
    peerAddresses: string[],
    peerPublicKeys?: Map<string, Uint8Array>,
  ): Promise<void> {
    if (peerPublicKeys) {
      for (const [addr, pk] of peerPublicKeys) {
        this.peerPublicKeys.set(addr.toLowerCase(), pk);
      }
    }

    const tasks = peerAddresses
      .map((a) => a.toLowerCase())
      .filter((a) => a !== this.localAddress && a.length > 0)
      .map(async (addr) => {
        if (this.peers.has(addr)) return; // 已存在，跳过

        const entry = this.createPeerEntry(addr);
        this.peers.set(addr, entry);

        const iAmInitiator = this.localAddress > addr;
        console.log(
          `[WebRTC] connectWithPeers ${addr.slice(0, 6)}... 我发起方=${iAmInitiator}（我=${this.localAddress.slice(0, 6)}）`,
        );

        // 字典序规则：localAddress 字典序 > peerAddress 时才主动发起（发 Offer）
        if (iAmInitiator) {
          await this.initiateOffer(addr);
        }
        // 被动方始终等待字典序更大的地址发起。发起方会重发 Offer，且在收到
        // peer-joined/presence-request 时再次发送，因此这里不能反向发起：
        // 跨浏览器环境下双方同时 Offer 会造成 glare 和 ICE ufrag 不匹配。
      });

    await Promise.allSettled(tasks);
  }

  /**
   * 主动向单个对端发起 Offer（内部调用）
   */
  private async initiateOffer(peerAddress: string): Promise<void> {
    const entry = this.peers.get(peerAddress);
    if (!entry) return;
    entry.isNegotiating = true;
    try {
      // 创建 DataChannel（发起方创建，接收方在 ondatachannel 中拿到）
      const dc = entry.pc.createDataChannel("chat", {
        ordered: true,
        // 可靠传输（不设置 maxRetransmits / maxPacketLifeTime）
      });
      this.attachDataChannelHandlers(peerAddress, dc);
      entry.dc = dc;

      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);

      // 不能只发送 createOffer() 返回的原始 SDP：它通常还没有任何 ICE candidate。
      // 等待收集完成（或超时）后发送 localDescription，使 SDP 自带候选；即使
      // 单独的 trickle ICE 广播被限流/丢失，也能继续连接。
      await this.waitForIceGatheringComplete(entry.pc);
      const gatheredOffer = entry.pc.localDescription;
      if (gatheredOffer?.type !== "offer" || !gatheredOffer.sdp) {
        throw new Error("本地 Offer SDP 未生成");
      }
      const candidateCount = this.countSdpCandidates(gatheredOffer.sdp);
      console.log(
        `[WebRTC] ${peerAddress.slice(0, 6)}... 发起 Offer，SDP candidates=${candidateCount}`,
      );

      await this.signaling.sendOffer(peerAddress, {
        type: "offer",
        sdp: gatheredOffer.sdp,
      });
      console.log(
        `[WebRTC] ${peerAddress.slice(0, 6)}... Offer 已通过信令发出`,
      );
      this.scheduleOfferRetries(peerAddress, entry);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[WebRTC] 向 ${peerAddress} 发起 Offer 失败:`, e);
      this.errorHandlers.forEach((h) => h(peerAddress, message));
      entry.isNegotiating = false;
      this.transitionState(entry, "failed");
    }
  }

  // ============ 消息收发 ============

  /**
   * 向某对端发送密文
   * - DataChannel 已连接 → 直接发送
   * - 否则：若注入了 offlineStore，暂存后返回 delivered=false
   */
  async send(ciphertext: string, peerAddress: string): Promise<SendResult> {
    const peer = peerAddress.toLowerCase();
    const entry = this.peers.get(peer);
    if (entry && entry.dc && entry.dc.readyState === "open") {
      try {
        entry.dc.send(ciphertext);
        return { peer, delivered: true };
      } catch (e) {
        return this.tryOfflineStore(peer, ciphertext, e);
      }
    }
    return this.tryOfflineStore(peer, ciphertext);
  }

  /**
   * 群发消息（向所有 connected 对端发送 + 未 connected 的尝试离线暂存）
   */
  async broadcast(ciphertext: string): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const peer of this.peers.keys()) {
      results.push(await this.send(ciphertext, peer));
    }
    return results;
  }

  // ============ 内部实现 ============

  private createPeerEntry(peerAddress: string, retryCount = 0): PeerEntry {
    const iceServers = getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    const entry: PeerEntry = {
      peerAddress,
      pc,
      dc: null,
      remoteSdpSet: false,
      iceQueue: [],
      state: "new",
      isNegotiating: false,
      createdAt: Date.now(),
      retryCount,
    };

    // 监听 connectionState 变化
    pc.addEventListener("connectionstatechange", () => {
      const cs = pc.connectionState as string;
      switch (cs) {
        case "new":
          this.transitionState(entry, "new");
          break;
        case "connecting":
        case "checking":
          this.transitionState(entry, "connecting");
          break;
        // PeerConnection 连上不等于聊天通道可发消息；必须等 DataChannel open。
        case "connected":
        case "completed":
          this.transitionState(
            entry,
            entry.dc?.readyState === "open" ? "connected" : "connecting",
          );
          break;
        case "disconnected":
          this.transitionState(entry, "disconnected");
          break;
        case "failed":
          this.transitionState(entry, "failed");
          void this.scheduleRetry(peerAddress);
          break;
        case "closed":
          this.transitionState(entry, "closed");
          break;
      }
    });

    // ICE 候选收集 → 通过信令发出去
    pc.addEventListener("icecandidate", (evt) => {
      if (!evt.candidate) return; // null 表示收集完成，不发送
      void this.signaling
        .sendIceCandidate(peerAddress, {
          candidate: evt.candidate.candidate,
          sdpMLineIndex: evt.candidate.sdpMLineIndex,
          sdpMid: evt.candidate.sdpMid,
        })
        .catch((error) => {
          console.warn(
            `[WebRTC] ${peerAddress.slice(0, 6)}... ICE candidate 发送失败:`,
            error,
          );
        });
    });

    // ICE 连接状态（备份通知，兼容旧浏览器）
    pc.addEventListener("iceconnectionstatechange", () => {
      const st = pc.iceConnectionState;
      if (st === "failed") this.transitionState(entry, "failed");
    });

    // 被动方接收 DataChannel
    pc.addEventListener("datachannel", (evt) => {
      if (entry.dc && entry.dc.readyState === "open") return;
      this.attachDataChannelHandlers(peerAddress, evt.channel);
      entry.dc = evt.channel;
    });

    this.transitionState(entry, "new");

    // 有些浏览器在信令/ICE 时序丢失后会永久停在 new/connecting，既不触发
    // failed 也不重试。主动方或已经收到 Offer 的被动方超过 20 秒仍未打开
    // DataChannel 时，显式进入失败恢复流程。
    setTimeout(() => {
      const current = this.peers.get(peerAddress);
      if (current !== entry || current.dc?.readyState === "open") return;
      const shouldRecover =
        this.localAddress > peerAddress || current.remoteSdpSet;
      if (
        shouldRecover &&
        (current.state === "new" ||
          current.state === "connecting" ||
          current.state === "disconnected")
      ) {
        console.warn(
          `[WebRTC] ${peerAddress.slice(0, 6)}... ${WebRTCChatService.CONNECTION_TIMEOUT_MS}ms 内未建立 DataChannel，触发重连`,
        );
        this.transitionState(current, "failed");
        void this.scheduleRetry(peerAddress);
      }
    }, WebRTCChatService.CONNECTION_TIMEOUT_MS);

    return entry;
  }

  private attachDataChannelHandlers(peer: string, dc: RTCDataChannel): void {
    dc.addEventListener("open", () => {
      console.log(`[WebRTC] DataChannel open: ${peer}`);
      const entry = this.peers.get(peer);
      if (entry && entry.dc === dc) this.transitionState(entry, "connected");
    });
    dc.addEventListener("close", () => {
      console.log(`[WebRTC] DataChannel close: ${peer}`);
      const entry = this.peers.get(peer);
      if (entry && entry.dc === dc && entry.pc.connectionState !== "closed") {
        this.transitionState(entry, "disconnected");
      }
    });
    dc.addEventListener("error", (e) => {
      console.error(`[WebRTC] DataChannel error: ${peer}`, e);
    });
    dc.addEventListener("message", (evt) => {
      if (typeof evt.data !== "string") {
        console.warn("[WebRTC] 丢弃非字符串消息:", typeof evt.data);
        return;
      }
      const received: ChatMessageReceived = {
        from: peer,
        payload: evt.data,
        receivedAt: Date.now(),
      };
      for (const h of this.messageHandlers) {
        try {
          h(received);
        } catch (e) {
          console.error("[WebRTC] messageHandler:", e);
        }
      }
    });
  }

  /**
   * 处理收到的信令消息
   */
  private async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    const from = msg.from.toLowerCase();
    if (from === this.localAddress) return;

    switch (msg.type) {
      case "offer":
        await this.handleOffer(from, msg.sdp!);
        break;
      case "answer":
        await this.handleAnswer(from, msg.sdp!);
        break;
      case "ice-candidate":
        await this.handleIceCandidate(from, msg.candidate!);
        break;
      case "peer-joined":
        // 新成员加入 → 如果已有公钥信息，自动尝试建立连接
        void this.autoConnectIfNeeded(from);
        break;
      case "peer-left":
        await this.cleanupPeer(from, "peer signaled leave");
        break;
      case "presence-request":
        // 新成员广播 presence-request → 回复我在
        void this.signaling.broadcastJoined().catch(() => {});
        void this.autoConnectIfNeeded(from);
        break;
      case "presence-response":
        // 对端回复在 → 自动连接
        void this.autoConnectIfNeeded(from);
        break;
    }
  }

  private async handleOffer(from: string, sdp: SdpData): Promise<void> {
    let entry = this.peers.get(from);
    if (!entry) {
      entry = this.createPeerEntry(from);
      this.peers.set(from, entry);
    }
    entry.isNegotiating = true;
    console.log(
      `[WebRTC] 收到 ${from.slice(0, 6)}... 的 Offer，SDP 长度=${sdp.sdp.length}`,
    );
    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: sdp.type,
          sdp: sdp.sdp,
        }),
      );
      entry.remoteSdpSet = true;

      // 刷新队列中的 ICE 候选
      for (const cand of entry.iceQueue) {
        try {
          await entry.pc.addIceCandidate(cand);
        } catch (e) {
          console.warn("[WebRTC] flush iceQueue candidate failed:", e);
        }
      }
      entry.iceQueue = [];

      // 生成 Answer
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);

      await this.waitForIceGatheringComplete(entry.pc);
      const gatheredAnswer = entry.pc.localDescription;
      if (gatheredAnswer?.type !== "answer" || !gatheredAnswer.sdp) {
        throw new Error("本地 Answer SDP 未生成");
      }
      const candidateCount = this.countSdpCandidates(gatheredAnswer.sdp);

      await this.signaling.sendAnswer(from, {
        type: "answer",
        sdp: gatheredAnswer.sdp,
      });
      console.log(
        `[WebRTC] ${from.slice(0, 6)}... Answer 已发出，SDP candidates=${candidateCount}`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[WebRTC] handleOffer from ${from} 失败:`, e);
      this.errorHandlers.forEach((h) => h(from, message));
    } finally {
      if (entry) entry.isNegotiating = false;
    }
  }

  private async handleAnswer(from: string, sdp: SdpData): Promise<void> {
    const entry = this.peers.get(from);
    if (!entry) {
      console.warn(`[WebRTC] 收到未知对端 ${from} 的 answer，忽略`);
      return;
    }
    // Offer 重发可能让多个 Answer 已经在路上；第一个会把状态推进到 stable，
    // 后续重复 Answer 必须忽略，否则 setRemoteDescription 会抛 wrong state。
    if (entry.pc.signalingState !== "have-local-offer") {
      console.warn(
        `[WebRTC] 收到 ${from.slice(0, 6)}... 的过期 Answer，当前状态=${entry.pc.signalingState}，忽略`,
      );
      return;
    }
    console.log(
      `[WebRTC] 收到 ${from.slice(0, 6)}... 的 Answer，SDP 长度=${sdp.sdp.length}`,
    );
    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: sdp.type,
          sdp: sdp.sdp,
        }),
      );
      entry.remoteSdpSet = true;

      for (const cand of entry.iceQueue) {
        try {
          await entry.pc.addIceCandidate(cand);
        } catch {}
      }
      entry.iceQueue = [];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[WebRTC] handleAnswer from ${from} 失败:`, e);
      this.errorHandlers.forEach((h) => h(from, message));
    } finally {
      entry.isNegotiating = false;
    }
  }

  private async handleIceCandidate(
    from: string,
    cand: IceCandidateData,
  ): Promise<void> {
    const entry = this.peers.get(from);
    const rtcCand = new RTCIceCandidate({
      candidate: cand.candidate,
      sdpMLineIndex: cand.sdpMLineIndex ?? null,
      sdpMid: cand.sdpMid ?? null,
    });
    if (!entry) {
      // 未知对端 → 先创建占位，放进队列，等 offer 到了后再 flush
      const tmp = this.createPeerEntry(from);
      this.peers.set(from, tmp);
      tmp.iceQueue.push(rtcCand);
      return;
    }
    if (entry.remoteSdpSet) {
      try {
        await entry.pc.addIceCandidate(rtcCand);
      } catch (e) {
        console.warn("[WebRTC] addIceCandidate 失败:", e);
      }
    } else {
      entry.iceQueue.push(rtcCand);
    }
  }

  private autoConnectIfNeeded(peerAddress: string): void {
    const addr = peerAddress.toLowerCase();
    if (addr === this.localAddress) return;
    const existing = this.peers.get(addr);
    if (existing) {
      if (existing.dc?.readyState === "open") {
        console.log(
          `[WebRTC] autoConnectIfNeeded(${addr.slice(0, 6)}...): DataChannel 已连接`,
        );
        return;
      }

      // 旧连接已经失败且重试耗尽时，对端重新上线必须开启一轮全新的协商。
      // 否则 peers 中残留的 failed entry 会让 autoConnect 永久跳过。
      if (
        this.localAddress > addr &&
        (existing.state === "failed" || existing.state === "closed")
      ) {
        console.warn(
          `[WebRTC] ${addr.slice(0, 6)}... 重新上线，重建失败的连接`,
        );
        try {
          existing.dc?.close();
        } catch {}
        try {
          existing.pc.close();
        } catch {}
        const replacement = this.createPeerEntry(addr);
        this.peers.set(addr, replacement);
        void this.initiateOffer(addr);
        return;
      }

      // 发起方的首个 offer 可能在对端订阅频道前发出。对端随后广播上线时，
      // 不能仅因为本地已有一个 stale peer 就跳过；重发当前 offer 可恢复握手。
      const pendingOffer = existing.pc.localDescription;
      if (
        this.localAddress > addr &&
        pendingOffer?.type === "offer" &&
        pendingOffer.sdp &&
        !existing.remoteSdpSet
      ) {
        console.warn(
          `[WebRTC] ${addr.slice(0, 6)}... 上线，重发尚未应答的 Offer`,
        );
        void this.signaling
          .sendOffer(addr, {
            type: "offer",
            sdp: pendingOffer.sdp,
          })
          .catch((error) => {
            console.warn(
              `[WebRTC] ${addr.slice(0, 6)}... Offer 重发失败:`,
              error,
            );
          });
      } else {
        console.log(
          `[WebRTC] autoConnectIfNeeded(${addr.slice(0, 6)}...): 已存在协商中的 peer`,
        );
      }
      return;
    }
    console.log(
      `[WebRTC] autoConnectIfNeeded(${addr.slice(0, 6)}...): 尝试建立连接（字典序我是否主动：${this.localAddress > addr}）`,
    );

    // 字典序主动方
    if (this.localAddress > addr) {
      const entry = this.createPeerEntry(addr);
      this.peers.set(addr, entry);
      void this.initiateOffer(addr);
    }
  }

  private async scheduleRetry(peerAddress: string): Promise<void> {
    const entry = this.peers.get(peerAddress);
    if (!entry) return;
    if (entry.retryCount >= 3) {
      console.warn(`[WebRTC] ${peerAddress} 失败重试 3 次，放弃`);
      return;
    }
    entry.retryCount += 1;
    const delay = 1000 * entry.retryCount; // 1s/2s/3s
    console.log(
      `[WebRTC] ${peerAddress} ${delay}ms 后第 ${entry.retryCount} 次重试`,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (!this.peers.has(peerAddress)) return; // 已被清理

    // 清理旧连接
    try {
      if (entry.dc) entry.dc.close();
    } catch {}
    try {
      entry.pc.close();
    } catch {}

    // 重建
    const newEntry = this.createPeerEntry(peerAddress, entry.retryCount);
    this.peers.set(peerAddress, newEntry);
    if (this.localAddress > peerAddress) {
      await this.initiateOffer(peerAddress);
    }
  }

  private async cleanupPeer(
    peerAddress: string,
    reason: string,
  ): Promise<void> {
    const entry = this.peers.get(peerAddress);
    if (!entry) return;
    console.log(`[WebRTC] 清理 ${peerAddress}: ${reason}`);
    try {
      if (entry.dc) entry.dc.close();
    } catch {}
    try {
      entry.pc.close();
    } catch {}
    this.peers.delete(peerAddress);
    this.transitionState(entry, "closed");
  }

  private async tryOfflineStore(
    peer: string,
    ciphertext: string,
    cause?: unknown,
  ): Promise<SendResult> {
    if (this.offlineStore) {
      try {
        const ok = await this.offlineStore({ peerAddress: peer, ciphertext });
        if (ok) return { peer, delivered: false };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { peer, delivered: false, error: `离线暂存失败: ${message}` };
      }
    }
    const msg =
      cause instanceof Error
        ? cause.message
        : cause
          ? String(cause)
          : "对端未连接";
    return { peer, delivered: false, error: msg };
  }

  private scheduleOfferRetries(peerAddress: string, entry: PeerEntry): void {
    void (async () => {
      for (const delay of [1500, 3000, 6000]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const current = this.peers.get(peerAddress);
        if (
          current !== entry ||
          current.remoteSdpSet ||
          current.dc?.readyState === "open"
        )
          return;
        const offer = current.pc.localDescription;
        if (offer?.type !== "offer" || !offer.sdp) return;
        try {
          console.warn(
            `[WebRTC] ${peerAddress.slice(0, 6)}... 未收到 Answer，重发 Offer`,
          );
          await this.signaling.sendOffer(peerAddress, {
            type: "offer",
            sdp: offer.sdp,
          });
        } catch (error) {
          console.warn(
            `[WebRTC] ${peerAddress.slice(0, 6)}... Offer 重试失败:`,
            error,
          );
        }
      }
    })();
  }

  /**
   * 等待 ICE gathering 完成。TURN/STUN 异常时不会无限阻塞，超时后使用已收集候选。
   */
  private async waitForIceGatheringComplete(
    pc: RTCPeerConnection,
    timeoutMs = 6000,
  ): Promise<void> {
    if (pc.iceGatheringState === "complete") return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        pc.removeEventListener("icegatheringstatechange", handleStateChange);
        resolve();
      };

      const handleStateChange = () => {
        if (pc.iceGatheringState === "complete") finish();
      };

      timeoutId = setTimeout(() => {
        console.warn(
          `[WebRTC] ICE gathering ${timeoutMs}ms 未完成，使用当前已收集候选`,
        );
        finish();
      }, timeoutMs);

      pc.addEventListener("icegatheringstatechange", handleStateChange);
      handleStateChange();
    });
  }

  private countSdpCandidates(sdp: string): number {
    return sdp.match(/^a=candidate:/gm)?.length ?? 0;
  }

  private transitionState(entry: PeerEntry, state: PeerConnectionState): void {
    if (entry.state === state) return;
    const previous = entry.state;
    entry.state = state;
    console.log(
      `[WebRTC] ${entry.peerAddress.slice(0, 6)}... connectionState: ${previous} → ${state}`,
    );
    for (const h of this.stateHandlers) {
      try {
        h(entry.peerAddress, state);
      } catch (e) {
        console.error("[WebRTC] stateHandler:", e);
      }
    }
  }
}
