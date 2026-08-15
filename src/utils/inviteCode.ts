// ============================================================
// inviteCode — 邀请码生成与解析工具
// 房间 ID + 链参数编码为邀请码/邀请链接
// ============================================================

/**
 * 生成邀请码（房间 ID 的 base36 编码）
 * @param roomId 房间 ID
 * @returns 邀请码字符串
 */
export function generateInviteCode(roomId: bigint): string {
  return roomId.toString(36).toUpperCase().padStart(6, '0');
}

/**
 * 解析邀请码为房间 ID
 * @param code 邀请码
 * @returns 房间 ID
 */
export function parseInviteCode(code: string): bigint | null {
  try {
    const cleaned = code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!cleaned) return null;
    return BigInt(parseInt(cleaned, 36));
  } catch {
    return null;
  }
}

/**
 * 生成邀请链接
 * 格式：https://当前域名/?room=邀请码
 * @param roomId 房间 ID
 * @returns 邀请链接
 */
export function generateInviteUrl(roomId: bigint): string {
  const code = generateInviteCode(roomId);
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://monadchat.pages.dev';
  return `${base}/?room=${code}`;
}

/**
 * 从 URL 参数中解析房间邀请码
 * @returns 房间 ID 或 null
 */
export function getRoomIdFromUrl(): bigint | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if (!code) return null;
  return parseInviteCode(code);
}
