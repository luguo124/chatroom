// ============================================================
// SmartAccountService — ERC-4337 账户抽象（gasless 交易）
//
// ⚠️ Monad 按 gas_limit 计费（非 gas used）
// 必须为已知固定成本的操作设置紧凑准确的 gas_limit
// 避免设置过高导致 MON 浪费
//
// MVP 策略：
// - 若配置了 Alchemy Bundler/Paymaster，使用 gasless 模式（待实现）
// - 若未配置，回退到普通钱包发送交易（RoomContract.ts 中的 writeContract）
// ============================================================

import type { Hex, Address } from 'viem';

// Alchemy Bundler / Paymaster URL
const BUNDLER_URL = import.meta.env.VITE_ALCHEMY_BUNDLER_URL || '';
const PAYMASTER_URL = import.meta.env.VITE_ALCHEMY_PAYMASTER_URL || '';

// 合约地址
const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS as Address) || '0x0000000000000000000000000000000000000000';

// Gas 限制（Monad 按 gas_limit 计费，需紧凑设置）
// 固定成本操作不用 eth_estimateGas，直接硬编码
export const GAS_LIMITS = {
  registerPublicKey: 80_000n, // ~50k 实际消耗，留 60% 余量
  createRoom: 200_000n,       // ~150k 实际消耗（含数组 push + 事件）
  joinRoom: 160_000n,         // ~120k 实际消耗
} as const;

/**
 * SmartAccountService — 封装 gasless 交易
 *
 * MVP 实现：
 * - isGaslessEnabled() 检测 Alchemy 配置
 * - 未配置时所有 gasless 方法抛出错误，前端回退到 RoomContract.ts 的普通钱包交易
 * - 配置后按 @alchemy/aa-core 实际 API 实现（需参考 Alchemy 官方文档）
 */
export class SmartAccountService {
  /**
   * 检查是否已配置 Alchemy Bundler/Paymaster
   */
  isGaslessEnabled(): boolean {
    return !!BUNDLER_URL && !!PAYMASTER_URL;
  }

  /**
   * Gasless 注册公钥
   * 需要已配置 Alchemy Bundler/Paymaster
   */
  async registerPublicKeyGasless(_publicKey: Uint8Array): Promise<Hex> {
    throw new Error(
      'Gasless 模式未启用：请在 .env 中配置 VITE_ALCHEMY_BUNDLER_URL 和 VITE_ALCHEMY_PAYMASTER_URL，' +
      '或使用普通钱包交易（RoomContract.ts 的 registerPublicKey）'
    );
  }

  /**
   * Gasless 创建房间
   */
  async createRoomGasless(_name: string, _publicKey: Uint8Array): Promise<Hex> {
    throw new Error(
      'Gasless 模式未启用：请在 .env 中配置 VITE_ALCHEMY_BUNDLER_URL 和 VITE_ALCHEMY_PAYMASTER_URL，' +
      '或使用普通钱包交易（RoomContract.ts 的 createRoom）'
    );
  }

  /**
   * Gasless 加入房间
   */
  async joinRoomGasless(_roomId: bigint, _publicKey: Uint8Array): Promise<Hex> {
    throw new Error(
      'Gasless 模式未启用：请在 .env 中配置 VITE_ALCHEMY_BUNDLER_URL 和 VITE_ALCHEMY_PAYMASTER_URL，' +
      '或使用普通钱包交易（RoomContract.ts 的 joinRoom）'
    );
  }
}

// 单例
export const smartAccountService = new SmartAccountService();
