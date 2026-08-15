// ============================================================
// KeyStore — IndexedDB 私钥存储
// 用 Dexie.js 管理 local_keys 表
// 阶段 3 最小化实现：仅存储用户 X25519 密钥对
// 阶段 5.2 会扩展为完整 WebStorageService（含 rooms/messages/members）
// ============================================================

import Dexie, { type Table } from 'dexie';
import { X25519_PUBLIC_KEY_LENGTH } from '../crypto/WebCryptoService';

export interface LocalKeyRecord {
  // 钱包地址（小写，主键）
  address: string;
  // PKCS8 格式私钥（用于跨会话恢复 CryptoKey）
  privateKeyPkcs8: Uint8Array;
  // 32 字节 raw 公钥（与链上注册一致，便于快速读取）
  publicKeyRaw: Uint8Array;
  // 创建/更新时间戳
  createdAt: number;
  updatedAt: number;
}

/**
 * 密钥存储数据库
 * 仅管理 local_keys 表；阶段 5 会升级 schema 至 v2 增加 rooms/messages/members
 */
class KeyStoreDatabase extends Dexie {
  localKeys!: Table<LocalKeyRecord, string>;

  constructor() {
    super('monadchat_keys');
    // v1: 仅 local_keys 表
    // 注意：Dexie 在 schema 升级时通过 ++id & 主键声明管理索引
    // 这里 address 是主键（非自增），用 '&address' 标记 unique primary key
    this.version(1).stores({
      localKeys: '&address, updatedAt',
    });
  }
}

// 单例（避免多次打开数据库）
let dbInstance: KeyStoreDatabase | null = null;

/**
 * 获取数据库单例
 * SSR 安全：仅在浏览器环境初始化
 */
function getDb(): KeyStoreDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB 不可用（当前环境非浏览器）');
  }
  if (!dbInstance) {
    dbInstance = new KeyStoreDatabase();
  }
  return dbInstance;
}

/**
 * 密钥存储服务
 */
export class KeyStore {
  /**
   * 保存密钥对（按钱包地址索引）
   * 同一地址重复调用会覆盖旧记录
   */
  static async saveKeyPair(
    address: string,
    privateKeyPkcs8: Uint8Array,
    publicKeyRaw: Uint8Array
  ): Promise<void> {
    if (publicKeyRaw.length !== X25519_PUBLIC_KEY_LENGTH) {
      throw new Error(
        `公钥长度异常：期望 ${X25519_PUBLIC_KEY_LENGTH} 字节，实际 ${publicKeyRaw.length} 字节`
      );
    }
    const normalizedAddress = address.toLowerCase();
    const now = Date.now();
    const existing = await this.getRecord(normalizedAddress);

    const record: LocalKeyRecord = {
      address: normalizedAddress,
      privateKeyPkcs8,
      publicKeyRaw,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await getDb().localKeys.put(record);
  }

  /**
   * 读取本地公钥（raw bytes）
   * 若未注册返回 null
   */
  static async getPublicKey(address: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(address.toLowerCase());
    return record?.publicKeyRaw ?? null;
  }

  /**
   * 读取本地私钥（PKCS8 格式）
   * 用于重新 import 为 CryptoKey
   */
  static async getPrivateKey(address: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(address.toLowerCase());
    return record?.privateKeyPkcs8 ?? null;
  }

  /**
   * 读取完整记录
   */
  static async getRecord(address: string): Promise<LocalKeyRecord | null> {
    const record = await getDb().localKeys.get(address.toLowerCase());
    return record ?? null;
  }

  /**
   * 检查本地是否已存在某地址的密钥
   */
  static async hasKey(address: string): Promise<boolean> {
    const record = await this.getRecord(address.toLowerCase());
    return record !== null;
  }

  /**
   * 删除某地址的密钥记录（账户切换时清理）
   */
  static async deleteKey(address: string): Promise<void> {
    await getDb().localKeys.delete(address.toLowerCase());
  }

  /**
   * 清空所有密钥（危险操作，仅用于登出/重置）
   */
  static async clearAll(): Promise<void> {
    await getDb().localKeys.clear();
  }
}
