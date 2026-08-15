// ============================================================
// WebCryptoService 单元测试
// 验证 X25519 + HKDF-SHA256 + AES-GCM-256 原语正确性
// 运行环境：Node 20+（内置 Web Crypto API 支持 X25519）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WebCryptoService,
  X25519_PUBLIC_KEY_LENGTH,
  AES_GCM_IV_LENGTH,
  isX25519Supported,
} from './WebCryptoService';

describe('WebCryptoService', () => {
  beforeEach(() => {
    // 跳过不支持 X25519 的环境
    if (!isX25519Supported()) {
      console.warn('跳过测试：当前环境不支持 X25519');
      return;
    }
  });

  describe('generateKeyPair', () => {
    it('应生成 X25519 密钥对（含 privateKey 和 publicKey）', async () => {
      const keyPair = await WebCryptoService.generateKeyPair();
      expect(keyPair).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey.type).toBe('private');
      expect(keyPair.publicKey.type).toBe('public');
    });

    it('密钥应支持 deriveKey 和 deriveBits 用途', async () => {
      const keyPair = await WebCryptoService.generateKeyPair();
      expect(keyPair.privateKey.usages).toContain('deriveKey');
      expect(keyPair.privateKey.usages).toContain('deriveBits');
    });
  });

  describe('exportPublicKey / importPublicKey', () => {
    it('导出公钥应为 32 字节 raw', async () => {
      const keyPair = await WebCryptoService.generateKeyPair();
      const raw = await WebCryptoService.exportPublicKey(keyPair.publicKey);
      expect(raw.length).toBe(X25519_PUBLIC_KEY_LENGTH);
      expect(raw).toBeInstanceOf(Uint8Array);
    });

    it('导入公钥后应能用于 ECDH 派生', async () => {
      const keyPair = await WebCryptoService.generateKeyPair();
      const raw = await WebCryptoService.exportPublicKey(keyPair.publicKey);
      const imported = await WebCryptoService.importPublicKey(raw);
      expect(imported.type).toBe('public');
      expect(imported.algorithm).toHaveProperty('name', 'X25519');
    });

    it('导入非法长度公钥应抛出错误', async () => {
      const badKey = new Uint8Array(31); // 错误长度
      await expect(WebCryptoService.importPublicKey(badKey)).rejects.toThrow(
        /公钥长度异常/
      );
    });
  });

  describe('exportPrivateKey / importPrivateKey', () => {
    it('私钥应可导出为 PKCS8 格式', async () => {
      const keyPair = await WebCryptoService.generateKeyPair(true);
      const pkcs8 = await WebCryptoService.exportPrivateKey(keyPair.privateKey);
      expect(pkcs8.length).toBeGreaterThan(32); // PKCS8 含 ASN.1 头部
      expect(pkcs8).toBeInstanceOf(Uint8Array);
    });

    it('私钥导出后应可重新导入并使用', async () => {
      const keyPair = await WebCryptoService.generateKeyPair(true);
      const pkcs8 = await WebCryptoService.exportPrivateKey(keyPair.privateKey);
      const imported = await WebCryptoService.importPrivateKey(pkcs8);
      expect(imported.type).toBe('private');
      expect(imported.usages).toContain('deriveKey');
    });

    it('non-extractable 私钥导出应抛出错误', async () => {
      const keyPair = await WebCryptoService.generateKeyPair(true);
      const pkcs8 = await WebCryptoService.exportPrivateKey(keyPair.privateKey);
      const nonExtractable = await WebCryptoService.importPrivateKey(pkcs8);
      await expect(
        WebCryptoService.exportPrivateKey(nonExtractable)
      ).rejects.toThrow(/不可导出/);
    });
  });

  describe('deriveSharedKey（ECDH + HKDF）', () => {
    it('双向 ECDH 应派生出相同的共享密钥', async () => {
      // Alice 和 Bob 各自生成密钥对
      const alice = await WebCryptoService.generateKeyPair();
      const bob = await WebCryptoService.generateKeyPair();

      // 交换公钥
      const alicePubRaw = await WebCryptoService.exportPublicKey(alice.publicKey);
      const bobPubRaw = await WebCryptoService.exportPublicKey(bob.publicKey);

      // Alice 用 Bob 的公钥派生
      const aliceShared = await WebCryptoService.deriveSharedKey(
        alice.privateKey,
        await WebCryptoService.importPublicKey(bobPubRaw)
      );

      // Bob 用 Alice 的公钥派生
      const bobShared = await WebCryptoService.deriveSharedKey(
        bob.privateKey,
        await WebCryptoService.importPublicKey(alicePubRaw)
      );

      // 两个派生密钥都应能加解密同一份数据（间接验证相同）
      // 由于 CryptoKey 不可直接比较，用加密-解密交叉验证
      const testData = new TextEncoder().encode('hello e2ee');
      const { iv, ciphertext } = await WebCryptoService.encrypt(aliceShared, testData);
      const decrypted = await WebCryptoService.decrypt(bobShared, iv, ciphertext);
      expect(Array.from(decrypted)).toEqual(Array.from(testData));
    });

    it('不同密钥对应派生出不同的共享密钥', async () => {
      const alice = await WebCryptoService.generateKeyPair();
      const bob = await WebCryptoService.generateKeyPair();
      const carol = await WebCryptoService.generateKeyPair();

      const bobPub = await WebCryptoService.importPublicKey(
        await WebCryptoService.exportPublicKey(bob.publicKey)
      );
      const carolPub = await WebCryptoService.importPublicKey(
        await WebCryptoService.exportPublicKey(carol.publicKey)
      );

      const sharedWithBob = await WebCryptoService.deriveSharedKey(alice.privateKey, bobPub);
      const sharedWithCarol = await WebCryptoService.deriveSharedKey(alice.privateKey, carolPub);

      // 用两个密钥分别加密同一明文，密文应不同（说明密钥不同）
      const testData = new TextEncoder().encode('test');
      const enc1 = await WebCryptoService.encrypt(sharedWithBob, testData);
      const enc2 = await WebCryptoService.encrypt(sharedWithCarol, testData);

      // 交叉解密应失败
      await expect(
        WebCryptoService.decrypt(sharedWithBob, enc2.iv, enc2.ciphertext)
      ).rejects.toThrow();
    });
  });

  describe('AES-GCM encrypt / decrypt', () => {
    it('应正确加解密 UTF-8 文本', async () => {
      const key = await WebCryptoService.generateMessageKey();
      const plaintext = new TextEncoder().encode('你好，MonadChat！🎉');
      const { iv, ciphertext } = await WebCryptoService.encrypt(key, plaintext);

      expect(iv.length).toBe(AES_GCM_IV_LENGTH);
      expect(ciphertext.length).toBeGreaterThan(plaintext.length); // 含 GCM tag (16B)

      const decrypted = await WebCryptoService.decrypt(key, iv, ciphertext);
      expect(new TextDecoder().decode(decrypted)).toBe('你好，MonadChat！🎉');
    });

    it('相同明文加密两次应产生不同密文（IV 随机）', async () => {
      const key = await WebCryptoService.generateMessageKey();
      const plaintext = new TextEncoder().encode('same message');

      const enc1 = await WebCryptoService.encrypt(key, plaintext);
      const enc2 = await WebCryptoService.encrypt(key, plaintext);

      expect(Array.from(enc1.iv)).not.toEqual(Array.from(enc2.iv));
      expect(Array.from(enc1.ciphertext)).not.toEqual(Array.from(enc2.ciphertext));
    });

    it('密文篡改后解密应失败', async () => {
      const key = await WebCryptoService.generateMessageKey();
      const plaintext = new TextEncoder().encode('tamper test');
      const { iv, ciphertext } = await WebCryptoService.encrypt(key, plaintext);

      // 篡改密文最后一个字节
      const tampered = new Uint8Array(ciphertext);
      tampered[tampered.length - 1] ^= 0xff;

      await expect(WebCryptoService.decrypt(key, iv, tampered)).rejects.toThrow();
    });

    it('IV 篡改后解密应失败', async () => {
      const key = await WebCryptoService.generateMessageKey();
      const plaintext = new TextEncoder().encode('iv tamper');
      const { iv, ciphertext } = await WebCryptoService.encrypt(key, plaintext);

      const tamperedIv = new Uint8Array(iv);
      tamperedIv[0] ^= 0xff;

      await expect(
        WebCryptoService.decrypt(key, tamperedIv, ciphertext)
      ).rejects.toThrow();
    });

    it('错误密钥解密应失败', async () => {
      const key1 = await WebCryptoService.generateMessageKey();
      const key2 = await WebCryptoService.generateMessageKey();
      const plaintext = new TextEncoder().encode('wrong key');
      const { iv, ciphertext } = await WebCryptoService.encrypt(key1, plaintext);

      await expect(WebCryptoService.decrypt(key2, iv, ciphertext)).rejects.toThrow();
    });
  });

  describe('exportAesKey / importAesKey', () => {
    it('AES 密钥导出后应可重新导入', async () => {
      const key = await WebCryptoService.generateMessageKey();
      const raw = await WebCryptoService.exportAesKey(key);
      expect(raw.length).toBe(32); // AES-256

      const imported = await WebCryptoService.importAesKey(raw);
      const plaintext = new TextEncoder().encode('round trip');
      const { iv, ciphertext } = await WebCryptoService.encrypt(imported, plaintext);
      const decrypted = await WebCryptoService.decrypt(imported, iv, ciphertext);
      expect(new TextDecoder().decode(decrypted)).toBe('round trip');
    });
  });

  describe('toHex / fromHex', () => {
    it('应正确双向转换', () => {
      const bytes = new Uint8Array([0x00, 0xff, 0xab, 0x12, 0xcd]);
      const hex = WebCryptoService.toHex(bytes);
      expect(hex).toBe('00ffab12cd');
      expect(Array.from(WebCryptoService.fromHex(hex))).toEqual(Array.from(bytes));
    });

    it('应处理 0x 前缀', () => {
      const bytes = new Uint8Array([0xde, 0xad]);
      expect(Array.from(WebCryptoService.fromHex('0xdead'))).toEqual(Array.from(bytes));
      expect(Array.from(WebCryptoService.fromHex('0XDEAD'))).toEqual(Array.from(bytes));
    });

    it('奇数长度 hex 应抛出错误', () => {
      expect(() => WebCryptoService.fromHex('abc')).toThrow(/偶数/);
    });
  });

  describe('constantTimeEqual', () => {
    it('相同数组返回 true', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(WebCryptoService.constantTimeEqual(a, b)).toBe(true);
    });

    it('不同数组返回 false', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 5]);
      expect(WebCryptoService.constantTimeEqual(a, b)).toBe(false);
    });

    it('不同长度返回 false', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(WebCryptoService.constantTimeEqual(a, b)).toBe(false);
    });
  });
});
