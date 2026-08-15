import { useEffect, useState } from "react";
import { ConfigProvider, theme, App as AntdApp, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { WalletConnect } from "../WalletConnect/WalletConnect";
import { CreateRoom } from "../CreateRoom/CreateRoom";
import { RoomList } from "../RoomList/RoomList";
import { JoinRoom } from "../JoinRoom/JoinRoom";
import { ChatRoom } from "../ChatRoom/ChatRoom";
import { useAppStore } from "../../stores/appStore";

const { Title, Text } = Typography;

type Lang = "zh" | "en";

function getLanguage(): Lang {
  const saved = localStorage.getItem("monadchat_language");
  if (saved === "zh" || saved === "en") return saved;
  const sys = (navigator.language || "zh").toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
}

function tr(zh: string, en: string): string {
  return getLanguage() === "en" ? en : zh;
}

interface EnvStatus {
  key: string;
  label: string;
  configured: boolean;
}

function checkEnv(): EnvStatus[] {
  return [
    {
      key: "VITE_SUPABASE_URL",
      label: "Supabase",
      configured: !!import.meta.env.VITE_SUPABASE_URL,
    },
    {
      key: "VITE_SUPABASE_ANON_KEY",
      label: "Realtime",
      configured: !!import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    {
      key: "VITE_TURN_USERNAME",
      label: "TURN",
      configured: !!import.meta.env.VITE_TURN_USERNAME,
    },
    {
      key: "VITE_TURN_CREDENTIAL",
      label: "Relay",
      configured: !!import.meta.env.VITE_TURN_CREDENTIAL,
    },
    {
      key: "VITE_MONAD_RPC_URL",
      label: "Monad RPC",
      configured: !!import.meta.env.VITE_MONAD_RPC_URL,
    },
  ];
}

interface ChatApplicationProps {
  onBackToSite: () => void;
}

export default function ChatApplication({
  onBackToSite,
}: ChatApplicationProps) {
  const [lang] = useState<Lang>(getLanguage);
  const [envStatus] = useState<EnvStatus[]>(checkEnv);
  const [activeRoomId, setActiveRoomId] = useState<bigint | null>(null);
  const [roomListVersion, setRoomListVersion] = useState(0);
  const { walletAddress } = useAppStore();
  const isConnected = !!walletAddress;

  useEffect(() => {
    localStorage.removeItem("monadchat_wallet_address");
  }, []);

  useEffect(() => {
    if (!isConnected) setActiveRoomId(null);
  }, [isConnected]);

  const allConfigured = envStatus.every((env) => env.configured);
  const locale = lang === "en" ? enUS : zhCN;

  return (
    <ConfigProvider
      locale={locale}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#7667ff",
          colorInfo: "#7667ff",
          borderRadius: 12,
          colorBgContainer: "rgba(20, 20, 31, 0.92)",
          colorBorder: "rgba(255, 255, 255, 0.09)",
          colorText: "rgba(255, 255, 255, 0.92)",
          colorTextSecondary: "rgba(255, 255, 255, 0.58)",
          controlHeight: 42,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        },
        components: {
          Button: { primaryShadow: "0 10px 28px rgba(118, 103, 255, 0.26)" },
          Input: { activeShadow: "0 0 0 3px rgba(118, 103, 255, 0.13)" },
        },
      }}
    >
      <AntdApp>
        <div className="app-shell">
          <div className="ambient-orb ambient-orb-one" />
          <div className="ambient-orb ambient-orb-two" />

          <div className="app-container">
            <header className="app-header">
              <button
                className="brand-lockup brand-home-button"
                type="button"
                onClick={onBackToSite}
                aria-label={tr("返回产品官网", "Back to product website")}
              >
                <div className="brand-mark" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div>
                  <Title level={2} className="brand-title">
                    MonadChat
                  </Title>
                  <Text className="brand-subtitle">
                    {tr(
                      "端到端加密的链上私密空间",
                      "Private onchain spaces with end-to-end encryption",
                    )}
                  </Text>
                </div>
              </button>
              <div className="chat-header-actions">
                <button
                  className="back-to-site-button"
                  type="button"
                  onClick={onBackToSite}
                >
                  {tr("产品官网", "Product site")}
                </button>
                <div className="wallet-area">
                  <WalletConnect />
                </div>
              </div>
            </header>

            <main className="app-main">
              {isConnected && activeRoomId !== null && (
                <div className="chat-view">
                  <ChatRoom
                    roomId={activeRoomId}
                    onBack={() => setActiveRoomId(null)}
                  />
                </div>
              )}

              {isConnected && activeRoomId === null && (
                <div className="room-dashboard">
                  <section className="dashboard-heading">
                    <div>
                      <span className="eyebrow">
                        {tr("你的私密空间", "Your private spaces")}
                      </span>
                      <Title level={1}>
                        {tr("房间控制台", "Room dashboard")}
                      </Title>
                      <Text>
                        {tr(
                          "通过邀请码进入新的会话，或回到已经加入的加密房间。",
                          "Join with an invite code or return to an encrypted room you already know.",
                        )}
                      </Text>
                    </div>
                    <div className="security-badge">
                      <span className="security-dot" />
                      {tr(
                        "Monad Testnet · 加密已启用",
                        "Monad Testnet · Encryption active",
                      )}
                    </div>
                  </section>

                  <section
                    className="action-card-grid"
                    aria-label={tr("房间操作", "Room actions")}
                  >
                    <JoinRoom onJoined={(roomId) => setActiveRoomId(roomId)} />
                    <CreateRoom
                      onRoomCreated={() =>
                        setRoomListVersion((version) => version + 1)
                      }
                    />
                  </section>

                  <RoomList
                    refreshKey={roomListVersion}
                    onSelectRoom={(roomId) => setActiveRoomId(roomId)}
                  />
                </div>
              )}

              {!isConnected && (
                <section className="welcome-panel">
                  <span className="eyebrow">
                    {tr("安全连接", "Secure connection")}
                  </span>
                  <Title level={1}>
                    {tr(
                      "连接钱包，进入你的加密房间",
                      "Connect your wallet to enter private rooms",
                    )}
                  </Title>
                  <Text>
                    {tr(
                      "房间成员关系记录在 Monad，消息内容仅在参与者设备之间解密。",
                      "Membership lives on Monad. Message content is decrypted only on participant devices.",
                    )}
                  </Text>
                  <div className="feature-row">
                    <span>◈ {tr("端到端加密", "End-to-end encrypted")}</span>
                    <span>◌ {tr("点对点传输", "Peer-to-peer delivery")}</span>
                    <span>◇ {tr("链上成员验证", "Onchain membership")}</span>
                  </div>
                </section>
              )}
            </main>

            <footer className="app-footer">
              <div>
                <strong>MonadChat</strong>
                <span>
                  {tr("私密、可验证、由你掌控", "Private, verifiable, yours")}
                </span>
              </div>
              <div
                className="env-status-row"
                aria-label={tr("服务状态", "Service status")}
              >
                {envStatus.map((env) => (
                  <span className="env-status" key={env.key} title={env.label}>
                    <i className={env.configured ? "is-ready" : ""} />
                    {env.label}
                  </span>
                ))}
              </div>
              {!allConfigured && (
                <Text type="warning" className="env-warning">
                  {tr("部分服务尚未配置", "Some services are not configured")}
                </Text>
              )}
            </footer>
          </div>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
