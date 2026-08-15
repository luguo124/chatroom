// ============================================================
// E2EEService — 端到端加密整合层
// 整合 WebCryptoService（原语）+ KeyStore（私钥存储）+ RoomContract（公钥上链）
//
// 加密方案（详见 spec 第十章）：
//   1. 群发场景：生成一次性 CEK (AES-GCM-256) 加密消息
//      → 对每个接收者用 ECDH+HKDF 派生 KEK，用 KEK 加密 CEK
//   2. 单聊场景：直接用 ECDH+HKDF 派生的密钥加密消息（无 CEK 包装层）
//   MVP 统一采用方案 1（CEK 包装），便于群聊扩展且代码路径单一
//
// 密文包格式（JSON，所有二进制字段用 base64）：
//   {
//     v: 1,                                  // 版本号
//     spk: "hex",                            // 发送者公钥（32B，用于接收方 ECDH）
//     iv: "base64",                          // 消息 AES-GCM IV（12B）
//     ct: "base64",                          // 消息密文（变长）
//     rs: [                                  // 接收者列表
//       { pk: "hex", ekIv: "base64", ek: "base64" }
//       // pk=32B 公钥, ekIv=CEK加密IV(12B), ek=加密的 CEK（48B = 32B CEK + 16B tag）
//     ]
//   }
// ============================================================

import {
  WebCryptoService,
  X25519_PUBLIC_KEY_LENGTH,
} from '../crypto/WebCryptoService';
import { KeyStore } from '../storage/KeyStore';
import {
  registerPublicKey as contractRegisterPublicKey,
  getUserPublicKey,
} from '../contract/RoomContract';

/** 加密消息包（序列化后通过 WebRTC DataChannel 传输） */
export interface EncryptedMessage {
  /** 协议版本号 */
  v: 1;
  /** 发送者公钥（hex，32 字节） */
  spk: string;
  /** AES-GCM IV（base64，12 字节） */
  iv: string;
  /** 消息密文（base64，变长） */
  ct: string;
  /** 接收者列表（每个含公钥 + 加密的 CEK） */
  rs: RecipientEncapsulation[];
}

export interface RecipientEncapsulation {
  /** 接收者公钥（hex，32 字节） */
  pk: string;
  /** CEK 加密用的 IV（base64，12 字节） */
  ekIv: string;
  /** 加密的 CEK（base64，48 字节 = 32B CEK + 16B GCM tag） */
  ek: string;
}

/** 加密消息结果 */
export interface EncryptResult {
  /** 序列化后的密文字符串（可直接通过 DataChannel 发送） */
  payload: string;
  /** 加密用的 CEK 长度（调试用） */
  recipientCount: number;
}

/** E2EE 初始化结果 */
export interface InitResult {
  /** 钱包地址 */
  address: string;
  /** 本地公钥（raw 32 字节） */
  publicKey: Uint8Array;
  /** 是否新生成了密钥对（false 表示复用已存在的） */
  isNewKey: boolean;
  /** 是否已上链注册（true 表示链上已有公钥） */
  isRegisteredOnChain: boolean;
}

// ============ Base64 工具（不依赖 Buffer，纯 Web API）============

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return WebCryptoService.toHex(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  return WebCryptoService.fromHex(hex);
}

/**
 * 端到端加密服务
 *
 * 使用前必须先调用 initForAccount(address) 加载本地密钥
 * 状态：当前账号的 CryptoKey 私钥/公钥（内存中，会话级）
 */
export class E2EEService {
  // 当前账号的会话状态
  private static currentAddress: string | null = null;
  private static privateKey: CryptoKey | null = null;
  private static publicKey: CryptoKey | null = null;
  private static publicKeyRaw: Uint8Array | null = null;

  // ============ 初始化与密钥管理 ============

  /**
   * 为指定钱包地址初始化 E2EE
   * - 若 IndexedDB 已有密钥：直接加载
   * - 若没有：生成新密钥对，存入 IndexedDB
   * - 同时检查链上是否已注册公钥（不强制注册，由调用方决定）
   *
   * @param address 钱包地址
   * @param autoRegisterOnChain 链上无公钥时是否自动注册（需要钱包签名，默认 false）
   */
  static async initForAccount(
    address: string,
    autoRegisterOnChain = false
  ): Promise<InitResult> {
    const normalizedAddress = address.toLowerCase();

    // 尝试从 IndexedDB 加载已有密钥
    const existing = await KeyStore.getRecord(normalizedAddress);
    let isNewKey = false;

    if (existing) {
      // 复用已存在密钥
      this.privateKey = await WebCryptoService.importPrivateKey(
        existing.privateKeyPkcs8
      );
      this.publicKey = await WebCryptoService.importPublicKey(
        existing.publicKeyRaw
      );
      this.publicKeyRaw = existing.publicKeyRaw;
    } else {
      // 生成新密钥对
      const keyPair = await WebCryptoService.generateKeyPair(true);
      const pubRaw = await WebCryptoService.exportPublicKey(keyPair.publicKey);
      const privPkcs8 = await WebCryptoService.exportPrivateKey(
        keyPair.privateKey
      );

      // 持久化到 IndexedDB
      await KeyStore.saveKeyPair(normalizedAddress, privPkcs8, pubRaw);

      // 重新 import 为 non-extractable（安全）
      this.privateKey = await WebCryptoService.importPrivateKey(privPkcs8);
      this.publicKey = await WebCryptoService.importPublicKey(pubRaw);
      this.publicKeyRaw = pubRaw;
      isNewKey = true;
    }

    this.currentAddress = normalizedAddress;

    // 检查链上公钥（不阻塞，失败仅警告）
    let isRegisteredOnChain = false;
    try {
      const onChain = await getUserPublicKey(normalizedAddress);
      // 链上未注册时返回 0x000...0
      isRegisteredOnChain = !/^0x0+$/.test(onChain);
    } catch (e) {
      console.warn('[E2EE] 查询链上公钥失败，跳过注册检查:', e);
    }

    // 自动注册（仅当链上未注册且本地是新密钥时）
    if (autoRegisterOnChain && !isRegisteredOnChain) {
      try {
        await this.registerPublicKeyOnChain(normalizedAddress as `0x${string}`);
        isRegisteredOnChain = true;
      } catch (e) {
        console.error('[E2EE] 自动注册公钥到链上失败:', e);
        // 不抛出，允许离线使用
      }
    }

    return {
      address: normalizedAddress,
      publicKey: this.publicKeyRaw!,
      isNewKey,
      isRegisteredOnChain,
    };
  }

  /**
   * 显式注册公钥到链上（调用合约 registerPublicKey）
   * @returns 交易 hash
   */
  static async registerPublicKeyOnChain(address: `0x${string}`): Promise<`0x${string}`> {
    if (!this.publicKeyRaw) {
      throw new Error('E2EE 未初始化，请先调用 initForAccount');
    }
    return contractRegisterPublicKey(address, this.publicKeyRaw);
  }

  /**
   * 获取当前账号的本地公钥（raw 32 字节）
   */
  static getMyPublicKey(): Uint8Array {
    if (!this.publicKeyRaw) {
      throw new Error('E2EE 未初始化，请先调用 initForAccount');
    }
    return this.publicKeyRaw;
  }

  /**
   * 获取当前账号的公钥（hex 格式）
   */
  static getMyPublicKeyHex(): string {
    return bytesToHex(this.getMyPublicKey());
  }

  /**
   * 当前是否已初始化
   */
  static isInitialized(): boolean {
    return this.privateKey !== null && this.publicKey !== null;
  }

  /**
   * 清除当前会话状态（账户切换/登出时调用）
   * 注意：不会删除 IndexedDB 中的密钥（下次重新登录可恢复）
   */
  static clearSession(): void {
    this.currentAddress = null;
    this.privateKey = null;
    this.publicKey = null;
    this.publicKeyRaw = null;
  }

  // ============ 加密 ============

  /**
   * 加密消息（群发）
   *
   * @param plaintext 明文（UTF-8 编码）
   * @param recipientPublicKeys 接收者公钥列表（raw bytes，每 32 字节）
   * @returns 序列化后的密文字符串
   */
  static async encrypt(
    plaintext: string | Uint8Array,
    recipientPublicKeys: Uint8Array[]
  ): Promise<EncryptResult> {
    if (!this.privateKey || !this.publicKeyRaw) {
      throw new Error('E2EE 未初始化，请先调用 initForAccount');
    }
    if (recipientPublicKeys.length === 0) {
      throw new Error('接收者公钥列表不能为空');
    }
    for (const pk of recipientPublicKeys) {
      if (pk.length !== X25519_PUBLIC_KEY_LENGTH) {
        throw new Error(
          `接收者公钥长度异常：期望 ${X25519_PUBLIC_KEY_LENGTH} 字节，实际 ${pk.length} 字节`
        );
      }
    }

    // 明文统一转 Uint8Array
    const plaintextBytes =
      typeof plaintext === 'string'
        ? new TextEncoder().encode(plaintext)
        : plaintext;

    // 步骤 1：生成一次性 CEK
    const cek = await WebCryptoService.generateMessageKey();
    const cekRaw = await WebCryptoService.exportAesKey(cek);

    // 步骤 2：用 CEK 加密消息
    const { iv, ciphertext } = await WebCryptoService.encrypt(cek, plaintextBytes);

    // 步骤 3：为每个接收者派生 KEK 并加密 CEK
    const recipients: RecipientEncapsulation[] = [];
    for (const recipientPk of recipientPublicKeys) {
      // 跳过自己（避免冗余封装；发送方本地有明文）
      if (
        WebCryptoService.constantTimeEqual(recipientPk, this.publicKeyRaw!)
      ) {
        continue;
      }

      const peerKey = await WebCryptoService.importPublicKey(recipientPk);
      const kek = await WebCryptoService.deriveSharedKey(this.privateKey!, peerKey);
      // 用 KEK 加密 CEK（32 字节 → 48 字节含 tag），每个接收者用独立随机 IV
      const { iv: cekIv, ciphertext: encryptedCek } =
        await WebCryptoService.encrypt(kek, cekRaw);
      recipients.push({
        pk: bytesToHex(recipientPk),
        ekIv: bytesToBase64(cekIv),
        ek: bytesToBase64(encryptedCek),
      });
    }

    if (recipients.length === 0) {
      throw new Error('接收者列表仅含自己，无需加密（请直接保存明文）');
    }

    // 步骤 4：组装密文包
    const message: EncryptedMessage = {
      v: 1,
      spk: bytesToHex(this.publicKeyRaw),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(ciphertext),
      rs: recipients,
    };

    return {
      payload: JSON.stringify(message),
      recipientCount: recipients.length,
    };
  }

  // ============ 解密 ============

  /**
   * 解密消息
   *
   * @param payload 序列化的密文字符串
   * @returns 解密后的明文（Uint8Array）
   * @throws 若消息非本人接收者、签名损坏、或密钥不匹配
   */
  static async decrypt(payload: string): Promise<Uint8Array> {
    if (!this.privateKey || !this.publicKeyRaw) {
      throw new Error('E2EE 未初始化，请先调用 initForAccount');
    }

    // 步骤 1：解析密文包
    let message: EncryptedMessage;
    try {
      message = JSON.parse(payload) as EncryptedMessage;
    } catch {
      throw new Error('密文格式损坏：JSON 解析失败');
    }
    if (message.v !== 1) {
      throw new Error(`不支持的密文版本：${message.v}`);
    }

    // 步骤 2：在接收者列表中查找匹配自己公钥的项
    const myPkHex = bytesToHex(this.publicKeyRaw);
    const recipient = message.rs.find((r) => r.pk.toLowerCase() === myPkHex.toLowerCase());
    if (!recipient) {
      throw new Error('当前账号不在接收者列表中，无法解密');
    }

    // 步骤 3：用发送者公钥 + 本地私钥派生 KEK
    const senderPk = hexToBytes(message.spk);
    if (senderPk.length !== X25519_PUBLIC_KEY_LENGTH) {
      throw new Error('发送者公钥长度异常');
    }
    const senderKey = await WebCryptoService.importPublicKey(senderPk);
    const kek = await WebCryptoService.deriveSharedKey(this.privateKey, senderKey);

    // 步骤 4：用 KEK 解密 CEK
    const encryptedCek = base64ToBytes(recipient.ek);
    const cekIv = base64ToBytes(recipient.ekIv);
    let cekRaw: Uint8Array;
    try {
      cekRaw = await WebCryptoService.decrypt(kek, cekIv, encryptedCek);
    } catch {
      throw new Error('CEK 解密失败：可能密钥不匹配或密文被篡改');
    }

    // 步骤 5：用 CEK 解密消息
    const cek = await WebCryptoService.importAesKey(cekRaw);
    const iv = base64ToBytes(message.iv);
    const ciphertext = base64ToBytes(message.ct);

    try {
      return await WebCryptoService.decrypt(cek, iv, ciphertext);
    } catch {
      throw new Error('消息解密失败：密文损坏或被篡改');
    }
  }

  /**
   * 解密消息（返回字符串）
   */
  static async decryptToString(payload: string): Promise<string> {
    const bytes = await this.decrypt(payload);
    return new TextDecoder().decode(bytes);
  }

  // ============ 工具：公钥格式转换 ============

  /**
   * 从 hex 字符串导入公钥（链上 bytes32 → raw 32 字节）
   */
  static hexToPublicKey(hex: string): Uint8Array {
    return hexToBytes(hex);
  }

  /**
   * 公钥转 hex 字符串（用于日志/UI 展示）
   */
  static publicKeyToHex(pk: Uint8Array): string {
    return bytesToHex(pk);
  }
}
