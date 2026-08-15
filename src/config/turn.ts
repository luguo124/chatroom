// Metered TURN 服务器配置
// 用于 WebRTC NAT 穿透回退（ICE P2P 失败时自动切换到 TURN 中继）
// 仅转发密文，无法解密消息内容
//
// 使用静态凭据方式（Metered 免费版提供固定 username/password）
// 优点：无 CORS 问题，无需额外 API 调用，连接速度快

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const turnUsername = import.meta.env.VITE_TURN_USERNAME;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

/**
 * 获取 WebRTC ICE Servers 配置
 * 包含 STUN + TURN（UDP/TCP/TLS），覆盖各种 NAT 场景
 */
export function getIceServers(): IceServer[] {
  if (!turnUsername || !turnCredential) {
    console.warn('[TURN] 缺少环境变量 VITE_TURN_USERNAME 或 VITE_TURN_CREDENTIAL，TURN 中继不可用');
    return [{ urls: 'stun:stun.relay.metered.ca:80' }];
  }

  return [
    // STUN（用于获取公网 IP，P2P 直连时用）
    { urls: 'stun:stun.relay.metered.ca:80' },
    // TURN UDP（首选，延迟最低）
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: turnUsername,
      credential: turnCredential,
    },
    // TURN TCP（UDP 被封锁时回退）
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: turnUsername,
      credential: turnCredential,
    },
    // TURN TLS 443（防火墙严格时回退，最可靠）
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: turnUsername,
      credential: turnCredential,
    },
    // TURN over TLS
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: turnUsername,
      credential: turnCredential,
    },
  ];
}
