// ============================================================
// ChatRoom — 聊天室主界面（阶段 5 核心集成）
// 数据流：
//   发送：明文 → E2EEService.encrypt(成员公钥列表) → WebRTCChatService
//         → 在线对端走 DataChannel；离线对端走 OfflineMessageStore 暂存
//   接收：DataChannel 密文 → E2EEService.decryptToString → IndexedDB → UI
//   上线：OfflineMessageStore.fetch 拉取离线密文 → 解密入库 → UI
// ============================================================

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Card,
  Input,
  Button,
  Tag,
  Typography,
  Space,
  Spin,
  Alert,
  message as antdMessage,
  Tooltip,
  Divider,
} from "antd";
import { useAppStore } from "../../stores/appStore";
import { E2EEService } from "../../services/e2ee/E2EEService";
import { SupabaseSignaling } from "../../services/signaling/SupabaseSignaling";
import {
  WebRTCChatService,
  type PeerConnectionState,
} from "../../services/webrtc/WebRTCChatService";
import { OfflineMessageStore } from "../../services/storage/OfflineMessageStore";
import { walletService } from "../../services/wallet/WalletService";
import {
  WebStorageService,
  type StoredMessage,
  type StoredMember,
  type OnlineStatus,
} from "../../services/storage/WebStorageService";
import {
  getRoom,
  getMemberPublicKeys,
  subscribeMemberJoined,
} from "../../services/contract/RoomContract";

const { Text, Title } = Typography;

const PAGE_SIZE = 30;

// 简易双语
const messages = {
  zh: {
    back: "返回",
    connecting: "正在建立加密连接...",
    members: "成员",
    online: "在线",
    offline: "离线",
    connectingState: "连接中",
    inputPlaceholder: "输入加密消息...",
    send: "发送",
    loadMore: "加载更早的消息",
    noMore: "没有更多消息了",
    loadHistory: "加载历史",
    onlySelf: "房间里暂时只有你，邀请其他成员加入后即可开始加密聊天",
    encryptFail: "加密失败",
    sendFail: "部分消息发送失败（已暂存为离线消息）",
    storedOffline: "对端离线，消息已加密暂存，对方上线后自动送达",
    fetchOfflineFail: "拉取离线消息失败",
    decryptFail: "解密失败的消息已跳过",
    you: "我",
    roomLoadFail: "加载房间信息失败",
    self: "本机",
    statusConnected: "加密通道已建立",
    statusPartial: "部分成员未连接",
    statusNone: "等待其他成员上线...",
  },
  en: {
    back: "Back",
    connecting: "Establishing encrypted connection...",
    members: "Members",
    online: "Online",
    offline: "Offline",
    connectingState: "Connecting",
    inputPlaceholder: "Type an encrypted message...",
    send: "Send",
    loadMore: "Load earlier messages",
    noMore: "No more messages",
    loadHistory: "History",
    onlySelf: "You are alone here. Invite members to start chatting",
    encryptFail: "Encryption failed",
    sendFail: "Some messages failed (stored offline)",
    storedOffline: "Peer offline, message stored encrypted for later delivery",
    fetchOfflineFail: "Failed to fetch offline messages",
    decryptFail: "Skipped undecryptable messages",
    you: "Me",
    roomLoadFail: "Failed to load room",
    self: "This device",
    statusConnected: "Encrypted channel established",
    statusPartial: "Some members not connected",
    statusNone: "Waiting for other members...",
  },
};

function getLang(): "zh" | "en" {
  const saved = localStorage.getItem("monadchat_language");
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "zh").toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function peerStateToOnlineStatus(
  state: PeerConnectionState | "unknown",
): OnlineStatus {
  switch (state) {
    case "connected":
      return "online";
    case "connecting":
    case "new":
      return "connecting";
    default:
      return "offline";
  }
}

interface ChatRoomProps {
  roomId: bigint;
  onBack: () => void;
}

interface ChatRoomMember extends StoredMember {
  peerState: PeerConnectionState | "unknown";
}

export function ChatRoom({ roomId, onBack }: ChatRoomProps) {
  const { walletAddress, e2eeReady } = useAppStore();
  const t = messages[getLang()];

  // 房间与成员
  const [roomName, setRoomName] = useState<string>("");
  const [members, setMembers] = useState<ChatRoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 消息
  const [msgs, setMsgs] = useState<StoredMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // 服务实例（ref 保证不随渲染重建）
  const signalingRef = useRef<SupabaseSignaling | null>(null);
  const webrtcRef = useRef<WebRTCChatService | null>(null);
  const membersRef = useRef<
    Map<string, { address: string; publicKeyHex: string }>
  >(new Map());
  const listBottomRef = useRef<HTMLDivElement | null>(null);
  const myAddress = (walletAddress ?? "").toLowerCase();
  const roomIdStr = roomId.toString();

  // ---------- 消息渲染辅助 ----------
  const appendMessages = useCallback((incoming: StoredMessage[]) => {
    if (incoming.length === 0) return;
    setMsgs((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const merged = [...prev, ...incoming.filter((m) => !seen.has(m.id))];
      merged.sort((a, b) => a.timestamp - b.timestamp);
      return merged;
    });
  }, []);

  // ---------- 初始化房间 ----------
  useEffect(() => {
    if (!myAddress || !e2eeReady) return;

    let disposed = false;
    let unsubMemberJoined: (() => void) | null = null;

    const init = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1. 读取房间信息与成员公钥
        const [room, memberKeys] = await Promise.all([
          getRoom(roomId),
          getMemberPublicKeys(roomId),
        ]);
        if (disposed) return;

        setRoomName(room.name);

        // 2. 成员表（含公钥 hex）写入内存 + IndexedDB
        const memberList: ChatRoomMember[] = memberKeys.addresses.map(
          (addr, i) => {
            const address = addr.toLowerCase();
            const publicKeyHex = memberKeys.publicKeys[i];
            membersRef.current.set(address, { address, publicKeyHex });
            return {
              roomId: roomIdStr,
              address,
              publicKey: publicKeyHex,
              displayName: null,
              onlineStatus: address === myAddress ? "online" : "offline",
              peerState: address === myAddress ? "connected" : "unknown",
            };
          },
        );
        setMembers(memberList);
        await WebStorageService.saveMembers(memberList);
        await WebStorageService.saveRoom({
          id: roomIdStr,
          name: room.name,
          ownerAddress: room.creator.toLowerCase(),
          joinedAt: Date.now(),
          lastMessagePreview: null,
          lastMessageAt: null,
          unreadCount: 0,
        });

        // 3. 加载本地历史消息（最新一页）
        const history = await WebStorageService.loadMessages(
          roomIdStr,
          0,
          PAGE_SIZE,
        );
        if (disposed) return;
        setMsgs(history);
        setHasMore(history.length === PAGE_SIZE);

        // 4. 建立信令 + WebRTC 连接（注意顺序：先注册 handler，再广播，避免对方回复被丢）
        const signaling = new SupabaseSignaling(roomId, myAddress);
        await signaling.join();
        if (disposed) return;
        signalingRef.current = signaling;

        const webrtc = new WebRTCChatService(signaling, myAddress);
        webrtc.start(); // 先注册信令消息 handler

        // 离线暂存钩子：WebRTC 送达失败时调用
        webrtc.setOfflineStore(async ({ peerAddress, ciphertext }) => {
          try {
            await OfflineMessageStore.store({
              roomId,
              senderAddress: myAddress as `0x${string}`,
              recipientAddress: peerAddress as `0x${string}`,
              ciphertext,
            });
            return true;
          } catch (e) {
            console.error("[ChatRoom] 离线暂存失败:", e);
            return false;
          }
        });

        // 接收消息：解密 → 入库 → 渲染
        webrtc.onMessage(async ({ from, payload }) => {
          try {
            const plaintext = await E2EEService.decryptToString(payload);
            const stored: StoredMessage = {
              id: WebStorageService.generateMessageId(),
              roomId: roomIdStr,
              senderAddress: from,
              content: plaintext,
              timestamp: Date.now(),
              type: "text",
              status: "delivered",
            };
            await WebStorageService.saveMessage(stored);
            await WebStorageService.touchRoom(
              roomIdStr,
              plaintext,
              stored.timestamp,
            );
            appendMessages([stored]);
          } catch (e) {
            console.warn("[ChatRoom] 解密失败，跳过消息:", e);
          }
        });

        // 对端连接状态 → 成员列表在线状态
        webrtc.onPeerStateChanged((peer, state) => {
          setMembers((prev) =>
            prev.map((m) =>
              m.address === peer ? { ...m, peerState: state } : m,
            ),
          );
          void WebStorageService.updateMemberStatus(
            roomIdStr,
            peer,
            peerStateToOnlineStatus(state),
          );
        });

        webrtc.onError((peer, err) => {
          console.warn(`[ChatRoom] 对端 ${formatAddress(peer)} 连接异常:`, err);
        });

        webrtcRef.current = webrtc;

        // 5. 与所有其他成员建立 DataChannel
        const peers = memberList
          .filter((m) => m.address !== myAddress)
          .map((m) => m.address);
        await webrtc.connectWithPeers(
          peers,
          new Map(
            peers.map((addr) => [
              addr,
              E2EEService.hexToPublicKey(
                membersRef.current.get(addr)!.publicKeyHex,
              ),
            ]),
          ),
        );

        // 所有回调、ref 和 peer 条目就绪后再宣告上线，避免对方回复过早到达。
        try {
          await signaling.requestPresence();
          await signaling.broadcastJoined();
        } catch (e) {
          console.warn("[ChatRoom] 加入广播失败（将由 Offer 重试恢复）:", e);
        }

        // 6. 设置离线签名器（用于后续 send 时暂存离线消息）
        OfflineMessageStore.setSigner(
          (msgText, addr) =>
            walletService.signMessage(addr, msgText) as Promise<`0x${string}`>,
        );

        // 7. 先完成初始化，让 UI 可用（离线消息拉取改为非阻塞）
        setLoading(false);

        // 8. 异步拉取离线消息并解密入库（不阻塞 UI，签名请求在后台进行）
        void (async () => {
          try {
            const offlineMsgs = await OfflineMessageStore.fetch({
              recipientAddress: myAddress as `0x${string}`,
              roomId,
            });
            if (disposed) return;
            for (const m of offlineMsgs) {
              try {
                const plaintext = await E2EEService.decryptToString(
                  m.ciphertext,
                );
                const stored: StoredMessage = {
                  id: `offline-${m.id}`,
                  roomId: roomIdStr,
                  senderAddress: m.senderAddress,
                  content: plaintext,
                  timestamp: new Date(m.createdAt).getTime(),
                  type: "text",
                  status: "delivered",
                };
                await WebStorageService.saveMessage(stored);
                appendMessages([stored]);
              } catch {
                // 跳过无法解密的（例如对方重置了密钥）
              }
            }
            if (offlineMsgs.length > 0) {
              await WebStorageService.touchRoom(
                roomIdStr,
                `${offlineMsgs.length} 条离线消息`,
                Date.now(),
              );
            }
          } catch (e) {
            // 离线拉取失败不阻塞聊天（用户拒绝签名或 Edge Function 异常）
            console.warn(t.fetchOfflineFail, e);
          }
        })();

        // 9. 订阅链上成员加入事件 → 动态补充成员并发起连接
        unsubMemberJoined = subscribeMemberJoined((evt) => {
          if (evt.roomId !== roomId) return;
          const address = evt.member.toLowerCase();
          if (membersRef.current.has(address)) return;
          membersRef.current.set(address, {
            address,
            publicKeyHex: evt.memberPublicKey,
          });
          const newMember: ChatRoomMember = {
            roomId: roomIdStr,
            address,
            publicKey: evt.memberPublicKey,
            displayName: null,
            onlineStatus: "connecting",
            peerState: "unknown",
          };
          setMembers((prev) => [...prev, newMember]);
          void WebStorageService.saveMember(newMember);
          if (webrtcRef.current && address !== myAddress) {
            webrtcRef.current.setPeerPublicKey(
              address,
              E2EEService.hexToPublicKey(evt.memberPublicKey),
            );
          }
        });
      } catch (e) {
        if (disposed) return;
        console.error("[ChatRoom] 初始化失败:", e);
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    };

    void init();

    return () => {
      disposed = true;
      unsubMemberJoined?.();
      void webrtcRef.current?.stop();
      void signalingRef.current?.leave();
      webrtcRef.current = null;
      signalingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, myAddress, e2eeReady]);

  // 消息更新后滚动到底部
  useEffect(() => {
    listBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  // ---------- 加载更早消息 ----------
  const loadMore = useCallback(async () => {
    const older = await WebStorageService.loadMessages(
      roomIdStr,
      msgs.length,
      PAGE_SIZE,
    );
    setHasMore(older.length === PAGE_SIZE);
    if (older.length > 0) {
      setMsgs((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...older.filter((m) => !seen.has(m.id)), ...prev];
        merged.sort((a, b) => a.timestamp - b.timestamp);
        return merged;
      });
    }
  }, [roomIdStr, msgs.length]);

  // ---------- 发送消息 ----------
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    // 接收者 = 除自己外的所有成员公钥
    const recipientPks: Uint8Array[] = [];
    for (const m of members) {
      if (m.address === myAddress) continue;
      recipientPks.push(E2EEService.hexToPublicKey(m.publicKey));
    }
    if (recipientPks.length === 0) {
      antdMessage.warning(t.onlySelf);
      return;
    }

    setSending(true);
    const localId = WebStorageService.generateMessageId();
    const timestamp = Date.now();

    try {
      // 加密
      const { payload } = await E2EEService.encrypt(text, recipientPks);

      // 本地先落库渲染（sending 状态）
      const localMsg: StoredMessage = {
        id: localId,
        roomId: roomIdStr,
        senderAddress: myAddress,
        content: text,
        timestamp,
        type: "text",
        status: "sending",
      };
      await WebStorageService.saveMessage(localMsg);
      appendMessages([localMsg]);
      setInput("");

      // 逐个对端发送（在线走 DataChannel，离线走暂存钩子）
      const webrtc = webrtcRef.current;
      let anyStored = false;
      let anySent = false;
      let anyFailed = false;
      if (webrtc) {
        for (const m of members) {
          if (m.address === myAddress) continue;
          const result = await webrtc.send(payload, m.address);
          if (result.delivered) anySent = true;
          else if (!result.error) anyStored = true;
          else anyFailed = true; // 送达失败且暂存失败
        }
      }

      // 更新本地消息状态（全部失败才标记 failed）
      const finalStatus: StoredMessage["status"] =
        anySent || anyStored ? "sent" : "failed";
      await WebStorageService.saveMessage({ ...localMsg, status: finalStatus });
      setMsgs((prev) =>
        prev.map((m) => (m.id === localId ? { ...m, status: finalStatus } : m)),
      );
      await WebStorageService.touchRoom(roomIdStr, text, timestamp);

      if (anySent) {
        // 至少一个对端实时送达
      } else if (anyStored) {
        antdMessage.info(t.storedOffline);
      } else if (anyFailed) {
        antdMessage.warning(t.sendFail);
      }
    } catch (e) {
      console.error("[ChatRoom] 发送失败:", e);
      antdMessage.error(
        `${t.encryptFail}: ${e instanceof Error ? e.message : String(e)}`,
      );
      await WebStorageService.saveMessage({
        id: localId,
        roomId: roomIdStr,
        senderAddress: myAddress,
        content: text,
        timestamp,
        type: "text",
        status: "failed",
      }).catch(() => {});
      setMsgs((prev) =>
        prev.map((m) =>
          m.id === localId ? { ...m, status: "failed" as const } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [input, sending, members, myAddress, roomIdStr, appendMessages, t]);

  // ---------- 渲染 ----------
  const otherMembers = members.filter((m) => m.address !== myAddress);
  const connectedCount = otherMembers.filter(
    (m) => m.peerState === "connected",
  ).length;

  const statusText =
    otherMembers.length === 0
      ? t.statusNone
      : connectedCount === otherMembers.length
        ? t.statusConnected
        : t.statusPartial;

  return (
    <Card
      style={{
        width: "100%",
        maxWidth: 640,
        background: "rgba(23,23,35,0.95)",
      }}
      title={
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button size="small" type="text" onClick={onBack}>
              {t.back}
            </Button>
            <Title
              level={5}
              style={{ color: "rgba(255,255,255,0.9)", margin: 0 }}
            >
              {roomName || `#${roomIdStr}`}
            </Title>
            <Tag color={connectedCount > 0 ? "green" : "default"}>
              {statusText}
            </Tag>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t.members}: {members.length}
          </Text>
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <Spin tip={t.connecting} />
        </div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message={t.roomLoadFail}
          description={error}
        />
      ) : (
        <>
          {/* 成员列表（截断地址 + WebRTC 在线状态） */}
          <Space wrap size={[8, 4]} style={{ marginBottom: 8 }}>
            {members.map((m) => {
              const status =
                m.address === myAddress
                  ? "online"
                  : peerStateToOnlineStatus(m.peerState);
              const color =
                status === "online"
                  ? "green"
                  : status === "connecting"
                    ? "orange"
                    : "default";
              return (
                <Tooltip key={m.address} title={m.address}>
                  <Tag color={color} style={{ fontSize: 11 }}>
                    {m.address === myAddress ? t.you : formatAddress(m.address)}
                    {m.address !== myAddress && status !== "online"
                      ? ` · ${status === "connecting" ? t.connectingState : t.offline}`
                      : ""}
                  </Tag>
                </Tooltip>
              );
            })}
          </Space>

          <Divider style={{ margin: "8px 0" }} />

          {/* 加载更早消息 */}
          {hasMore && (
            <div style={{ textAlign: "center", marginBottom: 8 }}>
              <Button size="small" type="link" onClick={loadMore}>
                {t.loadMore}
              </Button>
            </div>
          )}

          {/* 消息列表 */}
          <div
            style={{
              height: 360,
              overflowY: "auto",
              padding: "4px 8px",
              background: "rgba(0,0,0,0.25)",
              borderRadius: 8,
            }}
          >
            {msgs.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  color: "rgba(255,255,255,0.4)",
                  padding: "80px 16px",
                  fontSize: 12,
                }}
              >
                🔒 {t.onlySelf}
              </div>
            ) : (
              msgs.map((m) => {
                const mine = m.senderAddress === myAddress;
                return (
                  <div
                    key={m.id}
                    style={{
                      display: "flex",
                      justifyContent: mine ? "flex-end" : "flex-start",
                      margin: "6px 0",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        padding: "6px 12px",
                        borderRadius: 10,
                        background: mine
                          ? "rgba(75,63,227,0.55)"
                          : "rgba(255,255,255,0.08)",
                        wordBreak: "break-word",
                      }}
                    >
                      {!mine && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "rgba(255,255,255,0.5)",
                            marginBottom: 2,
                          }}
                        >
                          {formatAddress(m.senderAddress)}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 13,
                          color: "rgba(255,255,255,0.92)",
                        }}
                      >
                        {m.content}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          color: "rgba(255,255,255,0.4)",
                          textAlign: "right",
                          marginTop: 2,
                        }}
                      >
                        {new Date(m.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {mine && m.status === "failed" && " · ✕"}
                        {mine && m.status === "sending" && " · ⏳"}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={listBottomRef} />
          </div>

          {/* 输入区 */}
          <Space.Compact style={{ width: "100%", marginTop: 12 }}>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={handleSend}
              placeholder={t.inputPlaceholder}
              maxLength={2000}
              disabled={!e2eeReady}
            />
            <Button
              type="primary"
              onClick={handleSend}
              loading={sending}
              disabled={!input.trim()}
            >
              {t.send}
            </Button>
          </Space.Compact>
        </>
      )}
    </Card>
  );
}
