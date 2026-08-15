// ============================================================
// E2EEService 单元测试
// 验证端到端加解密协议正确性
// - mock KeyStore（内存模拟 IndexedDB）
// - mock RoomContract（模拟链上公钥查询/注册）
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============ Mock KeyStore（内存模拟 IndexedDB）============
const memoryKeys = new Map<string, { privateKeyPkcs8: Uint8Array; publicKeyRaw: Uint8Array }>();

vi.mock('../storage/KeyStore', () => ({
  KeyStore: {
    getRecord: vi.fn(async (address: string) => {
      const record = memoryKeys.get(address.toLowerCase());
      return record
        ? { address: address.toLowerCase(), ...record, createdAt: 0, updatedAt: 0 }
        : null;
    }),
    saveKeyPair: vi.fn(async (address: string, privateKeyPkcs8: Uint8Array, publicKeyRaw: Uint8Array) => {
      memoryKeys.set(address.toLowerCase(), { privateKeyPkcs8, publicKeyRaw });
    }),
    hasKey: vi.fn(async (address: string) => memoryKeys.has(address.toLowerCase())),
    deleteKey: vi.fn(async (address: string) => { memoryKeys.delete(address.toLowerCase()); }),
    clearAll: vi.fn(async () => { memoryKeys.clear(); }),
  },
}));

// ============ Mock RoomContract ============
const onChainKeys = new Map<string, string>(); // address -> publicKeyHex

vi.mock('../contract/RoomContract', () => ({
  registerPublicKey: vi.fn(async (address: string, publicKey: Uint8Array) => {
    const hex = '0x' + Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('');
    onChainKeys.set(address.toLowerCase(), hex);
    return '0xmock_register_txhash';
  }),
  getUserPublicKey: vi.fn(async (address: string) => {
    return onChainKeys.get(address.toLowerCase()) || '0x0000000000000000000000000000000000000000000000000000000000000000';
  }),
}));

// 导入被测模块（在 mock 之后）
import { E2EEService } from './E2EEService';
import { WebCryptoService } from '../crypto/WebCryptoService';

// ============ 测试用辅助函数 ============

/** 生成一个独立的密钥对（不依赖 E2EEService 状态），返回 raw 公钥 */
async function generateStandaloneKeyPair(): Promise<{
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
}> {
  const keyPair = await WebCryptoService.generateKeyPair(true);
  const publicKeyRaw = await WebCryptoService.exportPublicKey(keyPair.publicKey);
  return { publicKeyRaw, privateKey: keyPair.privateKey };
}

/** 生成一个随机钱包地址（用于测试） */
function randomAddress(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============ 测试 ============

describe('E2EEService', () => {
  beforeEach(() => {
    // 清空所有状态
    memoryKeys.clear();
    onChainKeys.clear();
    E2EEService.clearSession();
  });

  describe('initForAccount', () => {
    it('首次初始化应生成新密钥对', async () => {
      const addr = randomAddress();
      const result = await E2EEService.initForAccount(addr, false);

      expect(result.address).toBe(addr.toLowerCase());
      expect(result.isNewKey).toBe(true);
      expect(result.publicKey.length).toBe(32);
      expect(result.isRegisteredOnChain).toBe(false);
      expect(E2EEService.isInitialized()).toBe(true);
    });

    it('再次初始化应复用已存在的密钥对', async () => {
      const addr = randomAddress();
      const first = await E2EEService.initForAccount(addr, false);
      E2EEService.clearSession();
      const second = await E2EEService.initForAccount(addr, false);

      expect(second.isNewKey).toBe(false);
      expect(Array.from(second.publicKey)).toEqual(Array.from(first.publicKey));
    });

    it('初始化后 getMyPublicKey 应返回 32 字节公钥', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const pk = E2EEService.getMyPublicKey();
      expect(pk.length).toBe(32);
    });

    it('未初始化时 getMyPublicKey 应抛出错误', () => {
      expect(() => E2EEService.getMyPublicKey()).toThrow(/未初始化/);
    });

    it('autoRegisterOnChain=true 时应调用合约注册公钥', async () => {
      const addr = randomAddress();
      const result = await E2EEService.initForAccount(addr, true);
      expect(result.isRegisteredOnChain).toBe(true);
    });
  });

  describe('encrypt / decrypt 单接收者', () => {
    it('Alice 加密 → Bob 解密，明文应一致', async () => {
      // Alice 和 Bob 各自初始化
      const aliceAddr = randomAddress();
      const bobAddr = randomAddress();
      await E2EEService.initForAccount(aliceAddr, false);
      const bobKeyPair = await generateStandaloneKeyPair();

      // Alice 用 Bob 的公钥加密
      const plaintext = 'Hello Bob, this is Alice!';
      const { payload } = await E2EEService.encrypt(plaintext, [bobKeyPair.publicKeyRaw]);

      // 切换到 Bob 的身份
      E2EEService.clearSession();
      // 把 Bob 的密钥对写入 mock KeyStore
      const bobPkcs8 = await WebCryptoService.exportPrivateKey(bobKeyPair.privateKey);
      const { KeyStore } = await import('../storage/KeyStore');
      await KeyStore.saveKeyPair(bobAddr, bobPkcs8, bobKeyPair.publicKeyRaw);
      await E2EEService.initForAccount(bobAddr, false);

      // Bob 解密
      const decrypted = await E2EEService.decryptToString(payload);
      expect(decrypted).toBe(plaintext);
    });

    it('加密结果应为合法 JSON 字符串', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const bobKeyPair = await generateStandaloneKeyPair();

      const { payload } = await E2EEService.encrypt('test', [bobKeyPair.publicKeyRaw]);
      expect(() => JSON.parse(payload)).not.toThrow();

      const parsed = JSON.parse(payload);
      expect(parsed.v).toBe(1);
      expect(parsed.spk).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.iv).toBeTruthy();
      expect(parsed.ct).toBeTruthy();
      expect(Array.isArray(parsed.rs)).toBe(true);
      expect(parsed.rs.length).toBe(1);
      expect(parsed.rs[0].pk).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.rs[0].ekIv).toBeTruthy();
      expect(parsed.rs[0].ek).toBeTruthy();
    });
  });

  describe('encrypt / decrypt 多接收者', () => {
    it('Alice 加密 → Bob 和 Carol 都能解密', async () => {
      const aliceAddr = randomAddress();
      const bobAddr = randomAddress();
      const carolAddr = randomAddress();

      await E2EEService.initForAccount(aliceAddr, false);
      const bobKeyPair = await generateStandaloneKeyPair();
      const carolKeyPair = await generateStandaloneKeyPair();

      const plaintext = 'Group message for Bob and Carol';
      const { payload, recipientCount } = await E2EEService.encrypt(plaintext, [
        bobKeyPair.publicKeyRaw,
        carolKeyPair.publicKeyRaw,
      ]);

      expect(recipientCount).toBe(2);

      // Bob 解密
      E2EEService.clearSession();
      const bobPkcs8 = await WebCryptoService.exportPrivateKey(bobKeyPair.privateKey);
      const { KeyStore } = await import('../storage/KeyStore');
      await KeyStore.saveKeyPair(bobAddr, bobPkcs8, bobKeyPair.publicKeyRaw);
      await E2EEService.initForAccount(bobAddr, false);
      const bobDecrypted = await E2EEService.decryptToString(payload);
      expect(bobDecrypted).toBe(plaintext);

      // Carol 解密
      E2EEService.clearSession();
      const carolPkcs8 = await WebCryptoService.exportPrivateKey(carolKeyPair.privateKey);
      await KeyStore.saveKeyPair(carolAddr, carolPkcs8, carolKeyPair.publicKeyRaw);
      await E2EEService.initForAccount(carolAddr, false);
      const carolDecrypted = await E2EEService.decryptToString(payload);
      expect(carolDecrypted).toBe(plaintext);
    });

    it('密文包应包含所有接收者的封装', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const recipients = await Promise.all([
        generateStandaloneKeyPair(),
        generateStandaloneKeyPair(),
        generateStandaloneKeyPair(),
      ]);

      const { payload } = await E2EEService.encrypt('multi', recipients.map(r => r.publicKeyRaw));
      const parsed = JSON.parse(payload);
      expect(parsed.rs.length).toBe(3);
    });
  });

  describe('安全性验证', () => {
    it('非接收者无法解密', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const bobKeyPair = await generateStandaloneKeyPair();
      const { payload } = await E2EEService.encrypt('secret', [bobKeyPair.publicKeyRaw]);

      // 切换到 Carol（非接收者）
      E2EEService.clearSession();
      const carolAddr = randomAddress();
      await E2EEService.initForAccount(carolAddr, false);

      await expect(E2EEService.decrypt(payload)).rejects.toThrow(/不在接收者列表中/);
    });

    it('相同明文用不同接收者公钥加密产生不同密文', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const bobKeyPair = await generateStandaloneKeyPair();
      const carolKeyPair = await generateStandaloneKeyPair();

      const plaintext = 'same plaintext';
      const enc1 = await E2EEService.encrypt(plaintext, [bobKeyPair.publicKeyRaw]);
      const enc2 = await E2EEService.encrypt(plaintext, [carolKeyPair.publicKeyRaw]);

      expect(enc1.payload).not.toBe(enc2.payload);

      // 接收者公钥列表不同
      const p1 = JSON.parse(enc1.payload);
      const p2 = JSON.parse(enc2.payload);
      expect(p1.rs[0].pk).not.toBe(p2.rs[0].pk);
    });

    it('密文篡改后解密应失败', async () => {
      const aliceAddr = randomAddress();
      const bobAddr = randomAddress();
      await E2EEService.initForAccount(aliceAddr, false);
      const bobKeyPair = await generateStandaloneKeyPair();

      const { payload } = await E2EEService.encrypt('tamper test', [bobKeyPair.publicKeyRaw]);

      // 篡改密文
      const parsed = JSON.parse(payload);
      const tamperedCt = parsed.ct.slice(0, -4) + 'AAAA';
      const tamperedPayload = JSON.stringify({ ...parsed, ct: tamperedCt });

      // 切换到 Bob
      E2EEService.clearSession();
      const bobPkcs8 = await WebCryptoService.exportPrivateKey(bobKeyPair.privateKey);
      const { KeyStore } = await import('../storage/KeyStore');
      await KeyStore.saveKeyPair(bobAddr, bobPkcs8, bobKeyPair.publicKeyRaw);
      await E2EEService.initForAccount(bobAddr, false);

      await expect(E2EEService.decrypt(tamperedPayload)).rejects.toThrow();
    });

    it('损坏的 JSON 应抛出格式错误', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      await expect(E2EEService.decrypt('not a json')).rejects.toThrow(/JSON 解析失败/);
    });

    it('不支持的版本应抛出错误', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const badPayload = JSON.stringify({ v: 99, spk: '', iv: '', ct: '', rs: [] });
      await expect(E2EEService.decrypt(badPayload)).rejects.toThrow(/不支持的密文版本/);
    });

    it('空接收者列表应抛出错误', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      await expect(E2EEService.encrypt('test', [])).rejects.toThrow(/不能为空/);
    });

    it('接收者列表仅含自己时应抛出错误', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const myPk = E2EEService.getMyPublicKey();
      await expect(E2EEService.encrypt('test', [myPk])).rejects.toThrow(/仅含自己/);
    });

    it('非法长度的接收者公钥应抛出错误', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const badKey = new Uint8Array(31);
      await expect(E2EEService.encrypt('test', [badKey])).rejects.toThrow(/公钥长度异常/);
    });
  });

  describe('公钥格式转换', () => {
    it('hexToPublicKey / publicKeyToHex 应双向一致', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const pk = E2EEService.getMyPublicKey();
      const hex = E2EEService.publicKeyToHex(pk);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      const restored = E2EEService.hexToPublicKey(hex);
      expect(Array.from(restored)).toEqual(Array.from(pk));
    });
  });

  describe('Uint8Array 明文支持', () => {
    it('应支持直接传入 Uint8Array 明文', async () => {
      await E2EEService.initForAccount(randomAddress(), false);
      const bobKeyPair = await generateStandaloneKeyPair();
      const binaryPlaintext = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);

      const { payload } = await E2EEService.encrypt(binaryPlaintext, [bobKeyPair.publicKeyRaw]);

      // 切换到 Bob 解密
      E2EEService.clearSession();
      const bobAddr = randomAddress();
      const bobPkcs8 = await WebCryptoService.exportPrivateKey(bobKeyPair.privateKey);
      const { KeyStore } = await import('../storage/KeyStore');
      await KeyStore.saveKeyPair(bobAddr, bobPkcs8, bobKeyPair.publicKeyRaw);
      await E2EEService.initForAccount(bobAddr, false);

      const decrypted = await E2EEService.decrypt(payload);
      expect(Array.from(decrypted)).toEqual(Array.from(binaryPlaintext));
    });
  });
});
