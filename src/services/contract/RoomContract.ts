// ============================================================
// RoomContract — PrivateChatRoom 合约前端交互层
// 用 viem 封装合约读写与事件订阅
// ============================================================

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  decodeEventLog,
  type Hex,
  type Address,
  type Log,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import { PRIVATE_CHAT_ROOM_ABI } from './abi';

// 合约地址（从环境变量读取，部署后填入）
const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS as Address) || '0x0000000000000000000000000000000000000000';

// RPC URL
const RPC_URL = import.meta.env.VITE_MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';

// 公共客户端（只读，用公共 RPC）
const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
});

// ============ 类型定义 ============

export interface RoomInfo {
  id: bigint;
  creator: string;
  name: string;
  createdAt: bigint;
}

export interface RoomCreatedEvent {
  roomId: bigint;
  creator: string;
  name: string;
  creatorPublicKey: string;
  txHash: string;
  blockNumber: bigint;
}

export interface MemberJoinedEvent {
  roomId: bigint;
  member: string;
  memberPublicKey: string;
  txHash: string;
  blockNumber: bigint;
}

// ============ 写操作（需要 MetaMask 签名）============

function getWalletClient() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('MetaMask 未安装');
  }
  return createWalletClient({
    chain: monadTestnet,
    transport: custom(window.ethereum),
  });
}

/**
 * 注册公钥
 */
export async function registerPublicKey(
  account: Hex,
  publicKey: Uint8Array
): Promise<Hex> {
  const walletClient = getWalletClient();
  const publicKeyBytes32 = bytesToBytes32(publicKey);

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'registerPublicKey',
    args: [publicKeyBytes32],
    account,
  });

  return hash;
}

/**
 * 创建房间
 * @returns txHash 和 roomId
 */
export async function createRoom(
  account: Hex,
  name: string,
  publicKey: Uint8Array
): Promise<{ txHash: Hex; roomId: bigint }> {
  const walletClient = getWalletClient();
  const publicKeyBytes32 = bytesToBytes32(publicKey);

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'createRoom',
    args: [name, publicKeyBytes32],
    account,
  });

  // 等待交易确认
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // 从事件日志中解析 roomId
  let roomId = 0n;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: PRIVATE_CHAT_ROOM_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'RoomCreated') {
        roomId = (decoded.args as { roomId: bigint }).roomId;
        break;
      }
    } catch {
      // 跳过非目标事件
    }
  }

  return { txHash: hash, roomId };
}

/**
 * 加入房间
 */
export async function joinRoom(
  account: Hex,
  roomId: bigint,
  publicKey: Uint8Array
): Promise<Hex> {
  const walletClient = getWalletClient();
  const publicKeyBytes32 = bytesToBytes32(publicKey);

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'joinRoom',
    args: [roomId, publicKeyBytes32],
    account,
  });

  return hash;
}

// ============ 读操作（公共 RPC，无需签名）============

/**
 * 获取房间信息
 */
export async function getRoom(roomId: bigint): Promise<RoomInfo> {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'getRoom',
    args: [roomId],
  });

  const [id, creator, name, createdAt] = result as [bigint, string, string, bigint];
  return { id, creator, name, createdAt };
}

/**
 * 获取房间成员地址列表
 */
export async function getMembers(roomId: bigint): Promise<string[]> {
  return (await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'getMembers',
    args: [roomId],
  })) as string[];
}

/**
 * 获取房间成员的公钥列表（用于 ECDH 密钥协商）
 */
export async function getMemberPublicKeys(
  roomId: bigint
): Promise<{ addresses: string[]; publicKeys: string[] }> {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'getMemberPublicKeys',
    args: [roomId],
  });

  const [addresses, publicKeys] = result as [string[], string[]];
  return { addresses, publicKeys };
}

/**
 * 获取用户已加入的房间列表
 */
export async function getUserRooms(userAddress: string): Promise<bigint[]> {
  return (await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'getUserRooms',
    args: [userAddress as Hex],
  })) as bigint[];
}

/**
 * 获取用户公钥
 */
export async function getUserPublicKey(userAddress: string): Promise<string> {
  const publicKey = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'userPublicKeys',
    args: [userAddress as Hex],
  });

  return publicKey as string;
}

/**
 * 获取房间数量
 */
export async function getRoomCount(): Promise<bigint> {
  return (await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: PRIVATE_CHAT_ROOM_ABI,
    functionName: 'roomCount',
  })) as bigint;
}

// ============ 事件订阅 ============

/**
 * 订阅 RoomCreated 事件
 * @returns 取消订阅函数
 */
export function subscribeRoomCreated(
  onEvent: (event: RoomCreatedEvent) => void
): () => void {
  const unwatch = publicClient.watchEvent({
    address: CONTRACT_ADDRESS,
    event: PRIVATE_CHAT_ROOM_ABI.find(
      (item) => item.type === 'event' && item.name === 'RoomCreated'
    ) as never,
    onLogs: (logs: Log[]) => {
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: PRIVATE_CHAT_ROOM_ABI,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (decoded.eventName === 'RoomCreated') {
            const args = decoded.args as { roomId: bigint; creator: string; name: string; creatorPublicKey: string };
            onEvent({
              roomId: args.roomId,
              creator: args.creator,
              name: args.name,
              creatorPublicKey: args.creatorPublicKey,
              txHash: log.transactionHash ?? '0x',
              blockNumber: log.blockNumber ?? 0n,
            });
          }
        } catch (e) {
          console.error('解析 RoomCreated 事件失败:', e);
        }
      }
    },
  });

  return unwatch;
}

/**
 * 订阅 MemberJoined 事件
 */
export function subscribeMemberJoined(
  onEvent: (event: MemberJoinedEvent) => void,
  roomId?: bigint
): () => void {
  const unwatch = publicClient.watchEvent({
    address: CONTRACT_ADDRESS,
    event: PRIVATE_CHAT_ROOM_ABI.find(
      (item) => item.type === 'event' && item.name === 'MemberJoined'
    ) as never,
    args: (roomId !== undefined ? { roomId } : undefined) as never,
    onLogs: (logs: Log[]) => {
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: PRIVATE_CHAT_ROOM_ABI,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (decoded.eventName === 'MemberJoined') {
            const args = decoded.args as { roomId: bigint; member: string; memberPublicKey: string };
            onEvent({
              roomId: args.roomId,
              member: args.member,
              memberPublicKey: args.memberPublicKey,
              txHash: log.transactionHash ?? '0x',
              blockNumber: log.blockNumber ?? 0n,
            });
          }
        } catch (e) {
          console.error('解析 MemberJoined 事件失败:', e);
        }
      }
    },
  });

  return unwatch;
}

// ============ 辅助函数 ============

/**
 * Uint8Array 转 bytes32
 */
function bytesToBytes32(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 32) {
    throw new Error(`公钥长度必须为 32 字节，当前 ${bytes.length} 字节`);
  }
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;
}

export { CONTRACT_ADDRESS, publicClient };
