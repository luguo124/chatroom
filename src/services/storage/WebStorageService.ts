// ============================================================
// WebStorageService — 本地消息历史持久化（IndexedDB / Dexie）
// 表结构（与 spec 10.1 一致）：
//   rooms    — 房间本地缓存（id/name/owner/last_message/unread）
//   messages — 解密后的明文消息（按 room_id + timestamp 索引）
//   members  — 房间成员本地缓存（公钥 hex + 在线状态）
// 注：local_keys 表由 KeyStore 独立管理（monadchat_keys 库），此处不重复
// ============================================================

import Dexie, { type Table } from 'dexie';

// ============ 类型定义（对齐 spec 10.1）============

export interface StoredRoom {
  /** 链上 roomId（十进制字符串） */
  id: string;
  name: string;
  ownerAddress: string;
  joinedAt: number;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
  unreadCount: number;
}

export type MessageType = 'text' | 'image' | 'file' | 'system';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface StoredMessage {
  /** UUID（客户端生成） */
  id: string;
  roomId: string;
  senderAddress: string;
  /** 解密后的明文内容 */
  content: string;
  /** 发送时间戳（ms） */
  timestamp: number;
  type: MessageType;
  status: MessageStatus;
}

export type OnlineStatus = 'online' | 'offline' | 'connecting';

export interface StoredMember {
  roomId: string;
  /** 小写钱包地址 */
  address: string;
  /** X25519 公钥（hex，0x 前缀） */
  publicKey: string;
  displayName: string | null;
  onlineStatus: OnlineStatus;
}

// ============ 数据库定义 ============

class ChatDatabase extends Dexie {
  rooms!: Table<StoredRoom, string>;
  messages!: Table<StoredMessage, string>;
  members!: Table<StoredMember, [string, string]>;

  constructor() {
    super('monadchat');
    this.version(1).stores({
      // '&' 唯一主键；messages 按 roomId+timestamp 组合索引（倒序分页用）
      rooms: '&id, lastMessageAt',
      messages: '&id, [roomId+timestamp]',
      members: '&[roomId+address], roomId',
    });
  }
}

let dbInstance: ChatDatabase | null = null;

function getDb(): ChatDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB 不可用（当前环境非浏览器）');
  }
  if (!dbInstance) {
    dbInstance = new ChatDatabase();
  }
  return dbInstance;
}

// ============ 服务 API ============

export class WebStorageService {
  // ---------- rooms ----------

  /** 保存/更新房间（按 id 覆盖，保留已有 unread 等字段） */
  static async saveRoom(room: StoredRoom): Promise<void> {
    await getDb().rooms.put(room);
  }

  static async getRooms(): Promise<StoredRoom[]> {
    return getDb().rooms.orderBy('lastMessageAt').reverse().toArray();
  }

  static async getRoom(id: string): Promise<StoredRoom | null> {
    return (await getDb().rooms.get(id)) ?? null;
  }

  static async deleteRoom(id: string): Promise<void> {
    await getDb().transaction('rw', getDb().rooms, getDb().members, async () => {
      await getDb().rooms.delete(id);
      await getDb().members.where('roomId').equals(id).delete();
    });
  }

  /** 更新房间最后一条消息（预览 + 时间戳），可选累加未读数 */
  static async touchRoom(
    id: string,
    preview: string,
    at: number,
    incrementUnread = false
  ): Promise<void> {
    const room = await this.getRoom(id);
    if (!room) return;
    await getDb().rooms.update(id, {
      lastMessagePreview: preview.slice(0, 60),
      lastMessageAt: at,
      unreadCount: incrementUnread ? room.unreadCount + 1 : room.unreadCount,
    });
  }

  static async resetUnread(id: string): Promise<void> {
    await getDb().rooms.update(id, { unreadCount: 0 });
  }

  // ---------- messages ----------

  /** 保存单条消息（解密后的明文） */
  static async saveMessage(msg: StoredMessage): Promise<void> {
    await getDb().messages.put(msg);
  }

  /**
   * 分页加载消息（每页 limit 条，按时间倒序取、正序返回）
   * @param offset 跳过条数（0 = 最新一页）
   */
  static async loadMessages(
    roomId: string,
    offset = 0,
    limit = 30
  ): Promise<StoredMessage[]> {
    const rows = await getDb().messages
      .where('[roomId+timestamp]')
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .reverse()
      .offset(offset)
      .limit(limit)
      .toArray();
    // reverse() 后是最新在前，翻转回时间正序便于渲染
    return rows.reverse();
  }

  static async getMessageCount(roomId: string): Promise<number> {
    return getDb().messages.where('roomId').equals(roomId).count();
  }

  /** 清空房间消息（保留房间与成员记录） */
  static async clearMessages(roomId: string): Promise<void> {
    await getDb().messages.where('roomId').equals(roomId).delete();
  }

  /** 生成客户端消息 ID（UUID v4，无需依赖） */
  static generateMessageId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---------- members ----------

  static async saveMember(member: StoredMember): Promise<void> {
    await getDb().members.put(member);
  }

  static async saveMembers(members: StoredMember[]): Promise<void> {
    await getDb().members.bulkPut(members);
  }

  static async getMembers(roomId: string): Promise<StoredMember[]> {
    return getDb().members.where('roomId').equals(roomId).toArray();
  }

  static async updateMemberStatus(
    roomId: string,
    address: string,
    onlineStatus: OnlineStatus
  ): Promise<void> {
    await getDb().members.update([roomId, address.toLowerCase()], { onlineStatus });
  }
}
