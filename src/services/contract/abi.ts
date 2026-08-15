// PrivateChatRoom 合约 ABI（从合约源码生成）
// 仅包含前端调用的函数和事件
export const PRIVATE_CHAT_ROOM_ABI = [
  {
    type: 'function',
    name: 'registerPublicKey',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'publicKey', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createRoom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'publicKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'roomId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'joinRoom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'roomId', type: 'uint256' },
      { name: 'publicKey', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getMembers',
    stateMutability: 'view',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getMemberPublicKeys',
    stateMutability: 'view',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [
      { name: 'addresses', type: 'address[]' },
      { name: 'publicKeys', type: 'bytes32[]' },
    ],
  },
  {
    type: 'function',
    name: 'getUserRooms',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getRoom',
    stateMutability: 'view',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'creator', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'createdAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getMemberCount',
    stateMutability: 'view',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'userPublicKeys',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'roomCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'PublicKeyRegistered',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'publicKey', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RoomCreated',
    inputs: [
      { name: 'roomId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'creatorPublicKey', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MemberJoined',
    inputs: [
      { name: 'roomId', type: 'uint256', indexed: true },
      { name: 'member', type: 'address', indexed: true },
      { name: 'memberPublicKey', type: 'bytes32', indexed: false },
    ],
  },
] as const;
