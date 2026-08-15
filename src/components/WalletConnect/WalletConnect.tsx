// ============================================================
// WalletConnect — 钱包连接 UI 组件
// 提供"连接 MetaMask"按钮、地址显示、网络状态、断开连接
// ============================================================

import { Button, Space, Tag, Typography, Alert, Tooltip } from "antd";
import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { walletService } from "../../services/wallet/WalletService";
import { MONAD_TESTNET } from "../../config/chains";

const { Text } = Typography;

// 简易双语（阶段 1 后续接入 i18next 后替换）
const messages = {
  zh: {
    connect: "连接 MetaMask",
    install: "安装 MetaMask",
    installing: "连接中...",
    disconnect: "断开连接",
    notInstalled: "MetaMask 未安装，请先安装浏览器扩展",
    downloadHint: "点击前往 MetaMask 官网下载",
    wrongNetwork: "网络不正确，请切换到 Monad Testnet",
    network: "网络",
    account: "账户",
  },
  en: {
    connect: "Connect MetaMask",
    install: "Install MetaMask",
    installing: "Connecting...",
    disconnect: "Disconnect",
    notInstalled:
      "MetaMask not installed. Please install the browser extension first.",
    downloadHint: "Click to download from MetaMask official site",
    wrongNetwork: "Wrong network. Please switch to Monad Testnet.",
    network: "Network",
    account: "Account",
  },
};

function getLang(): "zh" | "en" {
  const sys = (navigator.language || "zh").toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
}

export function WalletConnect() {
  const {
    walletState,
    walletAddress,
    chainId,
    error,
    connectWallet,
    disconnectWallet,
    clearError,
    restoreSession,
  } = useAppStore();
  const lang = getLang();
  const t = messages[lang];

  // 应用启动时尝试恢复会话
  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const isInstalled = walletService.isMetaMaskInstalled();
  const isConnecting = walletState === "connecting";
  const isConnected = walletState === "connected" && !!walletAddress;
  const isWrongNetwork = isConnected && chainId !== MONAD_TESTNET.chainIdNumber;

  // 截断地址显示 0x12...3456
  const shortAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : "";

  const handleConnect = () => {
    if (!isInstalled) {
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    connectWallet();
  };

  // 未安装 MetaMask
  if (!isInstalled && !isConnected) {
    return (
      <Space
        direction="vertical"
        align="center"
        size="middle"
        style={{ width: "100%" }}
      >
        <Button type="primary" size="large" onClick={handleConnect}>
          {t.install}
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t.notInstalled}
        </Text>
        <Text type="secondary" style={{ fontSize: 11, opacity: 0.7 }}>
          {t.downloadHint}
        </Text>
      </Space>
    );
  }

  // 已连接
  if (isConnected) {
    return (
      <Space className="wallet-connected-bar" align="center" size={8} wrap>
        <Tag color="purple" className="wallet-address-tag">
          {shortAddress}
        </Tag>
        <Tag
          color={isWrongNetwork ? "error" : "success"}
          className="wallet-network-tag"
        >
          {t.network}:{" "}
          {chainId === MONAD_TESTNET.chainIdNumber
            ? "Monad Testnet"
            : `Chain ${chainId}`}
        </Tag>
        {isWrongNetwork && (
          <Text type="danger" className="wallet-network-warning">
            {t.wrongNetwork}
          </Text>
        )}
        <Tooltip title={t.disconnect}>
          <Button
            size="small"
            type="text"
            className="wallet-disconnect-button"
            onClick={disconnectWallet}
            aria-label={t.disconnect}
          >
            ✕
          </Button>
        </Tooltip>
      </Space>
    );
  }

  // 错误状态
  if (error) {
    return (
      <Space
        direction="vertical"
        align="center"
        size="small"
        style={{ width: "100%" }}
      >
        <Alert
          message={error}
          type="error"
          showIcon
          closable
          onClose={clearError}
          style={{ maxWidth: 400, fontSize: 12 }}
        />
        <Button
          type="primary"
          size="large"
          onClick={handleConnect}
          loading={isConnecting}
        >
          {t.connect}
        </Button>
      </Space>
    );
  }

  // 默认：未连接
  return (
    <Button
      type="primary"
      size="large"
      onClick={handleConnect}
      loading={isConnecting}
    >
      {isConnecting ? t.installing : t.connect}
    </Button>
  );
}
