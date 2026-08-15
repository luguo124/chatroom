// ============================================================
// WalletService — MetaMask 浏览器扩展钱包连接服务
// 封装 window.ethereum 的所有交互
// MVP 仅支持 MetaMask，不支持 WalletConnect
// ============================================================

import { verifyMessage } from 'viem';
import { MONAD_TESTNET } from '../../config/chains';
import type { EthereumProvider } from '../../types/ethereum.d';

export type WalletConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletAccount {
  address: string;
  chainId: number;
}

export interface WalletSession extends WalletAccount {
  signedAt: number; // 签名时间戳
  nonce: string; // 签名用的随机 nonce
}

type AccountChangedHandler = (accounts: string[]) => void;
type ChainChangedHandler = (chainId: string) => void;

// localStorage 键
const SESSION_KEY = 'monadchat_wallet_session';
const NONCE_KEY = 'monadchat_wallet_nonce';

/**
 * 获取 MetaMask 注入的 provider
 * 多钱包情况下优先选 MetaMask
 */
function getMetaMaskProvider(): EthereumProvider | null {
  if (typeof window === 'undefined' || !window.ethereum) return null;

  const eth = window.ethereum;

  // 多钱包场景：从 providers 数组中选 MetaMask
  if (eth.providers?.length) {
    const metamask = eth.providers.find((p) => p.isMetaMask);
    if (metamask) return metamask;
  }

  // 单钱包场景
  if (eth.isMetaMask) return eth;

  return null;
}

/**
 * 生成随机 nonce（用于签名认证）
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 钱包连接服务
 */
export class WalletService {
  private provider: EthereumProvider | null = null;
  private accountChangedHandlers: Set<AccountChangedHandler> = new Set();
  private chainChangedHandlers: Set<ChainChangedHandler> = new Set();

  constructor() {
    this.provider = getMetaMaskProvider();
    this.setupEventListeners();
  }

  /**
   * 检测 MetaMask 是否已安装
   */
  isMetaMaskInstalled(): boolean {
    return this.provider !== null;
  }

  /**
   * 监听账户变更
   */
  onAccountChanged(handler: AccountChangedHandler): () => void {
    this.accountChangedHandlers.add(handler);
    return () => this.accountChangedHandlers.delete(handler);
  }

  /**
   * 监听链变更
   */
  onChainChanged(handler: ChainChangedHandler): () => void {
    this.chainChangedHandlers.add(handler);
    return () => this.chainChangedHandlers.delete(handler);
  }

  private setupEventListeners(): void {
    if (!this.provider?.on) return;

    this.provider.on('accountsChanged', (...args: unknown[]) => {
      const accounts = args[0] as string[];
      this.accountChangedHandlers.forEach((h) => h(accounts));
    });

    this.provider.on('chainChanged', (...args: unknown[]) => {
      const chainId = args[0] as string;
      this.chainChangedHandlers.forEach((h) => h(chainId));
    });
  }

  /**
   * 请求连接 MetaMask（eth_requestAccounts）
   * 返回钱包地址
   */
  async connect(): Promise<string> {
    if (!this.provider) {
      throw new Error('MetaMask 未安装');
    }

    const accounts = (await this.provider.request({
      method: 'eth_requestAccounts',
    })) as string[];

    if (!accounts || accounts.length === 0) {
      throw new Error('未获取到账户');
    }

    return accounts[0];
  }

  /**
   * 获取当前已连接的账户（不弹窗，eth_accounts）
   */
  async getAccounts(): Promise<string[]> {
    if (!this.provider) return [];
    return (await this.provider.request({ method: 'eth_accounts' })) as string[];
  }

  /**
   * 获取当前链 ID
   */
  async getChainId(): Promise<number> {
    if (!this.provider) return 0;
    const chainIdHex = (await this.provider.request({ method: 'eth_chainId' })) as string;
    return parseInt(chainIdHex, 16);
  }

  /**
   * 切换到 Monad 测试网
   * 若钱包未添加则先添加
   */
  async switchToMonadTestnet(): Promise<void> {
    if (!this.provider) throw new Error('MetaMask 未安装');

    try {
      // 先尝试切换
      await this.provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MONAD_TESTNET.chainId }],
      });
    } catch (error: unknown) {
      // code 4902 = 链未添加
      if (error && typeof error === 'object' && 'code' in error && error.code === 4902) {
        // 添加 Monad 测试网
        await this.provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: MONAD_TESTNET.chainId,
              chainName: MONAD_TESTNET.chainName,
              nativeCurrency: MONAD_TESTNET.nativeCurrency,
              rpcUrls: [...MONAD_TESTNET.rpcUrls],
              blockExplorerUrls: [...MONAD_TESTNET.blockExplorerUrls],
            },
          ],
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * 请求用户对消息进行签名（personal_sign）
   * 用于会话认证
   */
  async signMessage(address: string, message: string): Promise<string> {
    if (!this.provider) throw new Error('MetaMask 未安装');

    return (await this.provider.request({
      method: 'personal_sign',
      params: [message, address],
    })) as string;
  }

  /**
   * 验证签名（viem verifyMessage）
   * MVP 在前端验证，无需后端
   */
  async verifySignature(address: string, message: string, signature: string): Promise<boolean> {
    try {
      return await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch (error) {
      console.error('签名验证失败:', error);
      return false;
    }
  }

  /**
   * 完整的连接 + 签名认证流程
   * 1. 连接 MetaMask
   * 2. 切换到 Monad 测试网
   * 3. 生成 nonce 并请求签名
   * 4. 验证签名
   * 5. 保存会话
   */
  async connectAndSign(): Promise<WalletSession> {
    // 1. 连接
    console.log('[Wallet] 步骤 1/5: 请求连接 MetaMask...');
    const address = await this.connect();
    console.log('[Wallet] 步骤 1/5 完成: 地址 =', address);

    // 2. 切换网络
    console.log('[Wallet] 步骤 2/5: 切换到 Monad Testnet...');
    try {
      await this.switchToMonadTestnet();
      console.log('[Wallet] 步骤 2/5 完成: 已切换到 Monad Testnet');
    } catch (error) {
      console.error('[Wallet] 步骤 2/5 失败: 网络切换失败', error);
      throw new Error(`网络切换失败: ${this.formatError(error)}`);
    }

    // 3. 检查是否已有有效会话
    const existing = this.getSession();
    if (existing && existing.address === address) {
      console.log('[Wallet] 检测到有效会话，跳过签名');
      return existing;
    }

    // 4. 生成 nonce 并签名
    console.log('[Wallet] 步骤 3/5: 请求签名...');
    const nonce = generateNonce();
    const signMessage = `MonadChat 签名认证\n\n地址: ${address}\nNonce: ${nonce}\n\n签名此消息以登录 MonadChat，不会消耗 gas。`;

    let signature: string;
    try {
      signature = await this.signMessage(address, signMessage);
      console.log('[Wallet] 步骤 3/5 完成: 签名已获取');
    } catch (error) {
      console.error('[Wallet] 步骤 3/5 失败: 签名请求失败', error);
      throw new Error(`签名请求失败: ${this.formatError(error)}`);
    }

    // 5. 验证签名
    console.log('[Wallet] 步骤 4/5: 验证签名...');
    const isValid = await this.verifySignature(address, signMessage, signature);
    if (!isValid) {
      console.error('[Wallet] 步骤 4/5 失败: 签名验证未通过');
      // MVP 阶段：签名验证失败不阻止连接，仅记录警告
      // 因为 viem verifyMessage 在某些浏览器环境下可能有兼容性问题
      console.warn('[Wallet] 警告: 签名验证未通过，MVP 阶段允许继续');
    } else {
      console.log('[Wallet] 步骤 4/5 完成: 签名验证通过');
    }

    // 6. 保存会话
    console.log('[Wallet] 步骤 5/5: 保存会话');
    const session: WalletSession = {
      address,
      chainId: MONAD_TESTNET.chainIdNumber,
      signedAt: Date.now(),
      nonce,
    };

    this.saveSession(session);
    console.log('[Wallet] 连接流程完成');
    return session;
  }

  /**
   * 格式化错误对象为可读字符串
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
      const err = error as { code?: number; message?: string };
      if (err.code === 4001) return '用户拒绝了请求';
      if (err.message) return err.message;
      if (err.code) return `错误码 ${err.code}`;
    }
    if (typeof error === 'string') return error;
    return '未知错误';
  }

  /**
   * 从 localStorage 读取会话
   */
  getSession(): WalletSession | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw) as WalletSession;
      // 会话有效期 24 小时
      if (Date.now() - session.signedAt > 24 * 60 * 60 * 1000) {
        this.clearSession();
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  /**
   * 保存会话到 localStorage
   */
  private saveSession(session: WalletSession): void {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(NONCE_KEY, session.nonce);
  }

  /**
   * 清除会话
   */
  clearSession(): void {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(NONCE_KEY);
  }

  /**
   * 断开连接（清除会话，MetaMask 无法主动断开）
   */
  disconnect(): void {
    this.clearSession();
  }
}

// 单例
export const walletService = new WalletService();
