// ============================================================
// CreateRoom — 创建房间 UI 组件
// 调用合约 createRoom，创建后显示房间 ID 和邀请码
// ============================================================

import { useState } from "react";
import { Button, Input, Form, message, Typography, Tag, Card } from "antd";
import { useAppStore } from "../../stores/appStore";
import { createRoom, getRoom } from "../../services/contract/RoomContract";
import { generateInviteCode, generateInviteUrl } from "../../utils/inviteCode";
import { E2EEService } from "../../services/e2ee/E2EEService";

const { Text } = Typography;

// 简易双语
const messages = {
  zh: {
    title: "创建房间",
    eyebrow: "新建空间",
    subtitle: "创建一个只对受邀成员开放的链上加密房间。",
    roomName: "房间名称",
    placeholder: "输入房间名称",
    create: "创建房间",
    creating: "创建中...",
    success: "房间创建成功",
    roomId: "房间 ID",
    inviteCode: "邀请码",
    inviteLink: "邀请链接",
    copyLink: "复制链接",
    copied: "已复制",
    needWallet: "请先连接钱包",
    e2eeNotReady: "加密层未就绪，请稍候",
    e2eeInitializing: "加密层初始化中...",
    publicKeyRegistered: "公钥已上链",
    publicKeyNotRegistered: "公钥将随创建房间上链",
  },
  en: {
    title: "Create Room",
    eyebrow: "New space",
    subtitle: "Create an encrypted onchain room for invited members only.",
    roomName: "Room Name",
    placeholder: "Enter room name",
    create: "Create Room",
    creating: "Creating...",
    success: "Room created successfully",
    roomId: "Room ID",
    inviteCode: "Invite Code",
    inviteLink: "Invite Link",
    copyLink: "Copy Link",
    copied: "Copied",
    needWallet: "Please connect wallet first",
    e2eeNotReady: "E2EE layer not ready, please wait",
    e2eeInitializing: "E2EE initializing...",
    publicKeyRegistered: "Public key registered on-chain",
    publicKeyNotRegistered: "Public key will be registered with room creation",
  },
};

function getLang(): "zh" | "en" {
  const sys = (navigator.language || "zh").toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
}

interface CreatedRoomInfo {
  roomId: bigint;
  name: string;
  txHash: string;
}

export function CreateRoom({
  onRoomCreated,
}: {
  onRoomCreated?: (room: CreatedRoomInfo) => void;
}) {
  const { walletAddress, e2eeReady, e2eeRegisteredOnChain } = useAppStore();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [createdRoom, setCreatedRoom] = useState<CreatedRoomInfo | null>(null);
  const t = messages[getLang()];

  const handleCreate = async () => {
    if (!walletAddress) {
      message.warning(t.needWallet);
      return;
    }
    if (!e2eeReady || !E2EEService.isInitialized()) {
      message.warning(t.e2eeNotReady);
      return;
    }

    try {
      const name = form.getFieldValue("name") as string;
      if (!name || !name.trim()) return;

      setLoading(true);

      // 使用 E2EE 真实公钥（X25519 32 字节 raw 公钥）
      const publicKey = E2EEService.getMyPublicKey();

      const { txHash, roomId } = await createRoom(
        walletAddress as `0x${string}`,
        name.trim(),
        publicKey,
      );

      setCreatedRoom({ roomId, name: name.trim(), txHash });
      message.success(t.success);
      onRoomCreated?.({ roomId, name: name.trim(), txHash });

      form.resetFields();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "创建房间失败";
      message.error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const inviteCode = createdRoom ? generateInviteCode(createdRoom.roomId) : "";
  const inviteUrl = createdRoom ? generateInviteUrl(createdRoom.roomId) : "";

  const handleCopyLink = () => {
    if (inviteUrl) {
      navigator.clipboard.writeText(inviteUrl);
      message.success(t.copied);
    }
  };

  return (
    <Card className="action-card create-action-card" bordered={false}>
      <div className="action-card-content">
        <div className="action-card-heading">
          <div className="action-icon create-icon" aria-hidden="true">
            ＋
          </div>
          <div>
            <span className="action-eyebrow">{t.eyebrow}</span>
            <Typography.Title level={3}>{t.title}</Typography.Title>
          </div>
        </div>
        <Text className="action-description">{t.subtitle}</Text>

        <Form form={form} layout="vertical" className="create-room-form">
          <Form.Item name="name" label={t.roomName}>
            <Input placeholder={t.placeholder} maxLength={50} size="large" />
          </Form.Item>

          <div className="key-status-row">
            {e2eeReady ? (
              <Tag color={e2eeRegisteredOnChain ? "success" : "processing"}>
                {e2eeRegisteredOnChain
                  ? `✓ ${t.publicKeyRegistered}`
                  : t.publicKeyNotRegistered}
              </Tag>
            ) : (
              <Tag color="default">{t.e2eeInitializing}</Tag>
            )}
          </div>

          <Button
            type="primary"
            className="create-room-button"
            onClick={handleCreate}
            loading={loading}
            disabled={!e2eeReady}
            block
          >
            {loading ? t.creating : t.create}
          </Button>
        </Form>

        {createdRoom && (
          <div className="created-room-result">
            <div>
              <small>{t.roomId}</small>
              <strong>#{createdRoom.roomId.toString()}</strong>
            </div>
            <div>
              <small>{t.inviteCode}</small>
              <code>{inviteCode}</code>
            </div>
            <Button size="small" type="text" onClick={handleCopyLink}>
              {t.copyLink}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
