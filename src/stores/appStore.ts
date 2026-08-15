// ============================================================
// appStore — 全局应用状态（Zustand）
// 管理钱包身份、连接状态、错误信息
// ============================================================

import { create } from 'zustand';
import {
  walletService,
  type WalletConnectionState,
  type WalletSession,
} from '../services/wallet/WalletService';
import { E2EEService } from '../services/e2ee/E2EEService';

interface AppState {
  // 钱包状态
  walletState: WalletConnectionState;
  walletAddress: string | null;
  chainId: number | null;
  session: WalletSession | null;
  error: string | null;
  // E2EE 状态
  e2eeReady: boolean;
  e2eePublicKeyHex: string | null;
  e2eeRegisteredOnChain: boolean;

  // 动作
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  clearError: () => void;
  setChainId: (chainId: number) => void;
  restoreSession: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  walletState: 'disconnected',
  walletAddress: null,
  chainId: null,
  session: null,
  error: null,
  e2eeReady: false,
  e2eePublicKeyHex: null,
  e2eeRegisteredOnChain: false,

  connectWallet: async () => {
    set({ walletState: 'connecting', error: null });

    if (!walletService.isMetaMaskInstalled()) {
      set({
        walletState: 'error',
        error: 'MetaMask 未安装，请先安装 MetaMask 浏览器扩展',
      });
      return;
    }

    try {
      const session = await walletService.connectAndSign();
      set({
        walletState: 'connected',
        walletAddress: session.address,
        chainId: session.chainId,
        session,
        error: null,
      });

      // 钱包连接成功后异步初始化 E2EE（不阻塞 UI）
      E2EEService.initForAccount(session.address, false)
        .then((result) => {
          set({
            e2eeReady: true,
            e2eePublicKeyHex: E2EEService.publicKeyToHex(result.publicKey),
            e2eeRegisteredOnChain: result.isRegisteredOnChain,
          });
          console.log('[E2EE] 初始化完成:', {
            isNewKey: result.isNewKey,
            registered: result.isRegisteredOnChain,
          });
        })
        .catch((e) => {
          console.error('[E2EE] 初始化失败:', e);
          set({
            e2eeReady: false,
            e2eePublicKeyHex: null,
            error: `加密层初始化失败: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
    } catch (error) {
      // MetaMask 错误可能不是 Error 实例（如 {code: 4001, message: "..."}）
      let message = '连接钱包失败';
      if (error instanceof Error) {
        message = error.message;
      } else if (error && typeof error === 'object') {
        // MetaMask 错误对象
        const err = error as { code?: number; message?: string; data?: unknown };
        if (err.message) {
          // code 4001 = 用户拒绝请求, -32603 = 内部错误
          if (err.code === 4001) {
            message = '用户拒绝了请求';
          } else {
            message = err.message;
          }
        }
      } else if (typeof error === 'string') {
        message = error;
      }
      console.error('[Wallet] 连接失败详情:', error);
      set({ walletState: 'error', error: message });
    }
  },

  disconnectWallet: () => {
    walletService.disconnect();
    E2EEService.clearSession();
    set({
      walletState: 'disconnected',
      walletAddress: null,
      chainId: null,
      session: null,
      error: null,
      e2eeReady: false,
      e2eePublicKeyHex: null,
      e2eeRegisteredOnChain: false,
    });
  },

  clearError: () => set({ error: null }),

  setChainId: (chainId: number) => set({ chainId }),

  restoreSession: () => {
    const session = walletService.getSession();
    if (session) {
      set({
        walletState: 'connected',
        walletAddress: session.address,
        chainId: session.chainId,
        session,
      });

      // 恢复会话时也异步初始化 E2EE
      E2EEService.initForAccount(session.address, false)
        .then((result) => {
          set({
            e2eeReady: true,
            e2eePublicKeyHex: E2EEService.publicKeyToHex(result.publicKey),
            e2eeRegisteredOnChain: result.isRegisteredOnChain,
          });
        })
        .catch((e) => {
          console.error('[E2EE] 恢复会话时初始化失败:', e);
        });
    }
  },
}));

// 监听 MetaMask 账户变更
walletService.onAccountChanged((accounts: string[]) => {
  if (accounts.length === 0) {
    // 用户在 MetaMask 中断开了连接
    useAppStore.getState().disconnectWallet();
  } else {
    const newAddress = accounts[0];
    const current = useAppStore.getState().walletAddress;
    if (current !== newAddress) {
      // 账户切换，清除旧会话（需重新签名）
      walletService.clearSession();
      useAppStore.setState({
        walletState: 'disconnected',
        walletAddress: null,
        chainId: null,
        session: null,
      });
    }
  }
});

// 监听 MetaMask 链变更
walletService.onChainChanged((chainIdHex: string) => {
  const chainId = parseInt(chainIdHex, 16);
  useAppStore.getState().setChainId(chainId);
});
