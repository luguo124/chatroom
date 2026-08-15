// ============================================================
// JoinRoom — 通过邀请码加入房间
// 支持手动输入邀请码，或 URL ?room= 参数自动填充
// 加入流程：解析邀请码 → 链上校验房间存在 → joinRoom(公钥上链) → 进入聊天室
// ============================================================

import { useEffect, useState } from "react";
import { Card, Input, Button, Typography, message as antdMessage } from "antd";
import { useAppStore } from "../../stores/appStore";
import { E2EEService } from "../../services/e2ee/E2EEService";
import { joinRoom, getRoom } from "../../services/contract/RoomContract";
import { parseInviteCode, getRoomIdFromUrl } from "../../utils/inviteCode";

const { Text, Title } = Typography;

const messages = {
  zh: {
    title: "加入房间",
    eyebrow: "快速加入",
    subtitle: "输入好友分享的邀请码，建立端到端加密连接。",
    placeholder: "输入邀请码，如 0000AB",
    join: "加入",
    joining: "正在加入...",
    invalidCode: "邀请码格式无效",
    roomNotFound: "房间不存在，请核对邀请码",
    alreadyMember: "你已在该房间中",
    success: "已加入房间",
    fail: "加入房间失败",
    e2eeNotReady: "加密层未就绪，请稍候重试",
    encrypted: "加入后自动建立端到端加密连接",
    fromUrl: "已从邀请链接识别房间",
  },
  en: {
    title: "Join Room",
    eyebrow: "Quick join",
    subtitle: "Enter a shared invite code to start an encrypted connection.",
    placeholder: "Invite code, e.g. 0000AB",
    join: "Join",
    joining: "Joining...",
    invalidCode: "Invalid invite code",
    roomNotFound: "Room not found, check the code",
    alreadyMember: "You are already a member",
    success: "Joined room",
    fail: "Failed to join room",
    e2eeNotReady: "E2EE not ready, retry shortly",
    encrypted: "End-to-end encryption starts automatically after joining",
    fromUrl: "Room detected from invite link",
  },
};

function getLang(): "zh" | "en" {
  const saved = localStorage.getItem("monadchat_language");
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "zh").toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

interface JoinRoomProps {
  onJoined: (roomId: bigint) => void;
}

export function JoinRoom({ onJoined }: JoinRoomProps) {
  const { walletAddress, e2eeReady } = useAppStore();
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const t = messages[getLang()];

  // URL ?room= 参数自动填充
  useEffect(() => {
    const fromUrl = getRoomIdFromUrl();
    if (fromUrl !== null) {
      setCode(fromUrl.toString(36).toUpperCase().padStart(6, "0"));
      antdMessage.info(t.fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = async () => {
    if (!walletAddress) return;
    if (!e2eeReady) {
      antdMessage.warning(t.e2eeNotReady);
      return;
    }
    const roomId = parseInviteCode(code);
    if (roomId === null) {
      antdMessage.error(t.invalidCode);
      return;
    }

    setJoining(true);
    try {
      // 校验房间存在（读公共 RPC，不花 gas）
      try {
        await getRoom(roomId);
      } catch {
        antdMessage.error(t.roomNotFound);
        return;
      }

      // 链上加入（带 E2EE 公钥，需 MetaMask 确认）
      const publicKey = E2EEService.getMyPublicKey();
      await joinRoom(walletAddress as `0x${string}`, roomId, publicKey);

      antdMessage.success(t.success);
      onJoined(roomId);
    } catch (e) {
      console.error("[JoinRoom] 加入失败:", e);
      const err = e as { code?: number; message?: string };
      const hint =
        err?.code === 4001 ? "用户拒绝了请求" : (err?.message ?? String(e));
      antdMessage.error(`${t.fail}: ${hint}`);
    } finally {
      setJoining(false);
    }
  };

  return (
    <Card className="action-card join-action-card" bordered={false}>
      <div className="action-card-content">
        <div className="action-card-heading">
          <div className="action-icon join-icon" aria-hidden="true">
            ↗
          </div>
          <div>
            <span className="action-eyebrow">{t.eyebrow}</span>
            <Title level={3}>{t.title}</Title>
          </div>
        </div>
        <Text className="action-description">{t.subtitle}</Text>

        <div className="join-input-shell">
          <Input
            value={code}
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^0-9A-Z]/g, "")
                  .slice(0, 12),
              )
            }
            onPressEnter={handleJoin}
            placeholder={t.placeholder}
            maxLength={12}
            variant="borderless"
            aria-label={t.placeholder}
          />
          <Button
            type="primary"
            onClick={handleJoin}
            loading={joining}
            disabled={!code.trim()}
          >
            {t.join}
            <span aria-hidden="true">→</span>
          </Button>
        </div>

        <div className="action-card-footnote">
          <span className="mini-lock" aria-hidden="true">
            ◇
          </span>
          {t.encrypted}
        </div>
      </div>
    </Card>
  );
}
