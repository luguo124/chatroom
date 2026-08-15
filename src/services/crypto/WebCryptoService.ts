// ============================================================
// WebCryptoService — 端到端加密原语封装
// 基于 Web Crypto API 实现：
//   - X25519 ECDH 密钥协商
//   - HKDF-SHA256 密钥派生
//   - AES-GCM-256 对称加密
// 链上公钥格式：32 字节 raw 公钥（合约存为 bytes32）
// ============================================================

// X25519 公钥/私钥长度（字节）
export const X25519_PUBLIC_KEY_LENGTH = 32;
export const X25519_PRIVATE_KEY_LENGTH = 32;

// AES-GCM-256
export const AES_GCM_KEY_LENGTH = 256; // bits
export const AES_GCM_IV_LENGTH = 12; // 12 字节 IV（96 bits），NIST 推荐

// HKDF 输出长度（派生 AES-GCM-256 密钥）
export const HKDF_OUTPUT_LENGTH = 32; // 256 bits = 32 bytes

// HKDF info（用于域分离，确保派生密钥用途唯一）
const HKDF_INFO = new TextEncoder().encode('MonadChat/v1/e2ee/aes-gcm-256');
// HKDF salt（固定值，可后续改为会话级随机盐并随密文传输；MVP 用固定值简化）
const HKDF_SALT = new TextEncoder().encode('MonadChat-HKDF-SHA256-salt-v1');

/**
 * 检测浏览器是否支持 X25519
 * Chrome 113+, Firefox 130+, Safari 17+
 */
export function isX25519Supported(): boolean {
  if (typeof crypto === 'undefined' || !crypto.subtle) return false;
  // Node 20+ 的 globalThis.crypto.subtle 也支持
  // 通过 generateKey 试探会污染密钥库，这里只做 duck-type 检测
  return typeof crypto.subtle.generateKey === 'function';
}

/**
 * X25519 密钥对（兼容 Web Crypto CryptoKeyPair 类型）
 */
export type X25519KeyPair = CryptoKeyPair;

/**
 * Web Crypto API 原语服务
 * 所有方法均为纯函数（无状态），便于测试
 */
export class WebCryptoService {
  /**
   * 生成 X25519 密钥对
   * - extractable: false（私钥不可导出，防止泄露）
   *   注意：为支持 IndexedDB 持久化，这里设为 true，但存储时使用 Dexie（同源隔离）
   *   阶段 3.1.2 要求私钥存 IndexedDB，故必须 extractable 才能导出存储
   *   持久化后可重新 import 为 non-extractable
   */
  static async generateKeyPair(extractable = true): Promise<X25519KeyPair> {
    this.assertSupport();
    // X25519 在 Web Crypto 中总是返回 CryptoKeyPair（非对称）
    // 但 TS 类型签名是 CryptoKeyPair | CryptoKey，需要断言
    const key = await crypto.subtle.generateKey(
      { name: 'X25519' },
      extractable,
      ['deriveKey', 'deriveBits']
    );
    return key as X25519KeyPair;
  }

  /**
   * 导出公钥为 raw bytes（32 字节）
   * 用于上链注册（合约 bytes32）和发送给其他用户
   */
  static async exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    const bytes = new Uint8Array(raw);
    if (bytes.length !== X25519_PUBLIC_KEY_LENGTH) {
      throw new Error(
        `X25519 公钥长度异常：期望 ${X25519_PUBLIC_KEY_LENGTH} 字节，实际 ${bytes.length} 字节`
      );
    }
    return bytes;
  }

  /**
   * 导出私钥为 PKCS8 格式
   * 用于 IndexedDB 持久化（ Dexie 结构化克隆可直接存 CryptoKey，但 PKCS8 更便于跨会话恢复）
   */
  static async exportPrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
    if (!privateKey.extractable) {
      throw new Error('私钥不可导出，无法持久化');
    }
    const raw = await crypto.subtle.exportKey('pkcs8', privateKey);
    return new Uint8Array(raw);
  }

  /**
   * 从 raw bytes 导入公钥（用于解密时从对端公钥建立共享密钥）
   */
  static async importPublicKey(rawPublicKey: Uint8Array): Promise<CryptoKey> {
    if (rawPublicKey.length !== X25519_PUBLIC_KEY_LENGTH) {
      throw new Error(
        `公钥长度异常：期望 ${X25519_PUBLIC_KEY_LENGTH} 字节，实际 ${rawPublicKey.length} 字节`
      );
    }
    return crypto.subtle.importKey(
      'raw',
      rawPublicKey,
      { name: 'X25519' },
      false, // 公钥可安全设置为 non-extractable
      [] // 公钥不参与 derive，仅作为 deriveBits/deriveKey 的参数
    );
  }

  /**
   * 从 PKCS8 格式导入私钥（IndexedDB 恢复会话时使用）
   * 导入后设为 non-extractable，防止运行时被再次导出
   */
  static async importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'X25519' },
      false, // 恢复后设为 non-extractable
      ['deriveKey', 'deriveBits']
    );
  }

  /**
   * ECDH 派生共享密钥，并用 HKDF-SHA256 派生 AES-GCM-256 密钥
   *
   * 流程：
   *   1. ECDH(myPrivate, peerPublic) → 32 字节共享秘密
   *   2. HKDF-SHA256(sharedSecret, salt, info) → 32 字节 AES-GCM-256 密钥
   *
   * 注意：HKDF 在 Web Crypto 中只能通过 deriveKey/deriveBits 调用，
   *      输入密钥必须是 ECDH 派生出的 CryptoKey（不可直接用 raw bytes）
   */
  static async deriveSharedKey(
    myPrivateKey: CryptoKey,
    peerPublicKey: CryptoKey
  ): Promise<CryptoKey> {
    // 步骤 1：ECDH 派生共享秘密（CryptoKey，不可导出）
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'X25519', public: peerPublicKey },
      myPrivateKey,
      256 // X25519 输出固定 256 bits
    );

    // 步骤 2：将共享秘密导入为 HKDF 的输入密钥（baseKey）
    const baseKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      'HKDF',
      false,
      ['deriveKey', 'deriveBits']
    );

    // 步骤 3：HKDF-SHA256 派生 AES-GCM-256 密钥
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT,
        info: HKDF_INFO,
      },
      baseKey,
      { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
      false, // 派生密钥不可导出
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 生成一次性 AES-GCM-256 密钥（用于消息加密）
   * 群聊场景下：随机生成 CEK，加密消息；再用每个接收者的 ECDH-KEK 加密 CEK
   */
  static async generateMessageKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
      true, // extractable，便于用 KEK 加密后传输
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 用 AES-GCM-256 加密
   * @returns iv (12 字节) + ciphertext
   */
  static async encrypt(
    key: CryptoKey,
    plaintext: Uint8Array
  ): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );
    return { iv, ciphertext: new Uint8Array(ciphertext) };
  }

  /**
   * 用 AES-GCM-256 解密
   */
  static async decrypt(
    key: CryptoKey,
    iv: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<Uint8Array> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new Uint8Array(plaintext);
  }

  /**
   * 导出 AES-GCM 密钥为 raw bytes（用于 KEK 包装）
   */
  static async exportAesKey(key: CryptoKey): Promise<Uint8Array> {
    if (!key.extractable) {
      throw new Error('AES 密钥不可导出');
    }
    const raw = await crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
  }

  /**
   * 从 raw bytes 导入 AES-GCM 密钥
   */
  static async importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
      extractable,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 安全比较两个 Uint8Array（常数时间，防止时序攻击）
   */
  static constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  /**
   * Uint8Array → hex string
   */
  static toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * hex string → Uint8Array
   */
  static fromHex(hex: string): Uint8Array {
    if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
    if (hex.length % 2 !== 0) throw new Error('hex 长度必须为偶数');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  private static assertSupport(): void {
    if (!isX25519Supported()) {
      throw new Error(
        '当前环境不支持 Web Crypto X25519，请使用 Chrome 113+/Firefox 130+/Safari 17+ 或 Node 20+'
      );
    }
  }
}
