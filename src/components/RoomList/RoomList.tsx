// ============================================================
// RoomList — 已加入房间的响应式卡片网格
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { Button, Empty, Skeleton, Typography, message } from "antd";
import { useAppStore } from "../../stores/appStore";
import { getUserRooms, getRoom } from "../../services/contract/RoomContract";
import { generateInviteCode } from "../../utils/inviteCode";

const { Text, Title } = Typography;

const messages = {
  zh: {
    title: "我的房间",
    subtitle: "所有已加入的加密会话",
    empty: "还没有房间，使用上方邀请码加入或创建一个新房间",
    refresh: "刷新",
    loadError: "加载房间失败",
    creator: "创建者",
    createdAt: "创建于",
    inviteCode: "房间邀请码",
    copy: "复制",
    copied: "邀请码已复制",
    copyError: "无法复制邀请码",
    enter: "进入房间",
    owner: "我创建的",
    roomId: "房间",
  },
  en: {
    title: "My Rooms",
    subtitle: "All encrypted conversations you have joined",
    empty: "No rooms yet. Join with an invite code above or create a new room.",
    refresh: "Refresh",
    loadError: "Failed to load rooms",
    creator: "Creator",
    createdAt: "Created",
    inviteCode: "Room invite code",
    copy: "Copy",
    copied: "Invite code copied",
    copyError: "Could not copy invite code",
    enter: "Enter room",
    owner: "Created by me",
    roomId: "Room",
  },
};

function getLang(): "zh" | "en" {
  const saved = localStorage.getItem("monadchat_language");
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "zh").toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

interface RoomListItem {
  id: bigint;
  name: string;
  creator: string;
  createdAt: bigint;
}

interface RoomListProps {
  onSelectRoom?: (roomId: bigint) => void;
  refreshKey?: number;
}

export function RoomList({ onSelectRoom, refreshKey = 0 }: RoomListProps) {
  const { walletAddress } = useAppStore();
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const t = messages[getLang()];

  const loadRooms = useCallback(async () => {
    if (!walletAddress) return;

    setLoading(true);
    try {
      const roomIds = await getUserRooms(walletAddress);
      const roomDetails = await Promise.all(
        roomIds.map(async (id) => {
          const room = await getRoom(id);
          return {
            id: room.id,
            name: room.name,
            creator: room.creator,
            createdAt: room.createdAt,
          };
        }),
      );
      setRooms(roomDetails);
    } catch (error) {
      console.error(t.loadError, error);
      message.error(t.loadError);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, t.loadError]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms, refreshKey]);

  const formatAddress = (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`;

  const formatTime = (timestamp: bigint) =>
    new Date(Number(timestamp) * 1000).toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  const copyInviteCode = async (roomId: bigint) => {
    try {
      await navigator.clipboard.writeText(generateInviteCode(roomId));
      message.success(t.copied);
    } catch {
      message.error(t.copyError);
    }
  };

  return (
    <section className="room-section">
      <header className="section-heading">
        <div>
          <Title level={3}>{t.title}</Title>
          <Text>{t.subtitle}</Text>
        </div>
        <Button
          className="refresh-button"
          type="text"
          onClick={loadRooms}
          loading={loading}
        >
          <span aria-hidden="true">↻</span>
          {t.refresh}
        </Button>
      </header>

      {loading && rooms.length === 0 ? (
        <div className="room-card-grid" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div className="room-tile room-tile-skeleton" key={item}>
              <Skeleton
                active
                paragraph={{ rows: 4 }}
                title={{ width: "55%" }}
              />
            </div>
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <div className="room-empty-state">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.empty} />
        </div>
      ) : (
        <div className="room-card-grid">
          {rooms.map((room) => {
            const inviteCode = generateInviteCode(room.id);
            const isOwner =
              room.creator.toLowerCase() === walletAddress?.toLowerCase();
            const roomInitial =
              room.name.trim().slice(0, 1).toUpperCase() || "#";

            return (
              <article className="room-tile" key={room.id.toString()}>
                <div className="room-tile-glow" />
                <div className="room-card-topline">
                  <div className="room-avatar" aria-hidden="true">
                    {roomInitial}
                  </div>
                  <div className="room-identity">
                    <div className="room-label-row">
                      <span>
                        {t.roomId} #{room.id.toString()}
                      </span>
                      {isOwner && <span className="owner-chip">{t.owner}</span>}
                    </div>
                    <Title level={4}>{room.name}</Title>
                  </div>
                </div>

                <div className="room-meta-row">
                  <span>
                    <small>{t.creator}</small>
                    <strong>{formatAddress(room.creator)}</strong>
                  </span>
                  <span>
                    <small>{t.createdAt}</small>
                    <strong>{formatTime(room.createdAt)}</strong>
                  </span>
                </div>

                <div className="invite-code-box">
                  <div>
                    <small>{t.inviteCode}</small>
                    <code>{inviteCode}</code>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    aria-label={`${t.copy} ${inviteCode}`}
                    onClick={() => void copyInviteCode(room.id)}
                  >
                    {t.copy}
                  </Button>
                </div>

                <Button
                  type="primary"
                  className="enter-room-button"
                  block
                  onClick={() => onSelectRoom?.(room.id)}
                >
                  {t.enter}
                  <span aria-hidden="true">→</span>
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
