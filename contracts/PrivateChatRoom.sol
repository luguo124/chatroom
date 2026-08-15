// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PrivateChatRoom — Monad 链上私密聊天室注册合约
 *
 * 功能：
 * - 用户注册公钥（X25519 ECDH 用）
 * - 创建房间（记录房间名 + 创建者公钥）
 * - 加入房间（记录成员地址 + 公钥）
 * - 查询房间成员
 *
 * 安全模型：
 * - 链上仅存元数据与公钥，消息走链下 P2P 加密通道
 * - 任何人可创建/加入房间（MVP 无权限控制，后续可加邀请码）
 * - 公钥为 32 字节 X25519 公钥（非 Ethereum 签名公钥）
 */
contract PrivateChatRoom {
    // ============ 事件 ============

    event PublicKeyRegistered(address indexed user, bytes32 publicKey);
    event RoomCreated(uint256 indexed roomId, address indexed creator, string name, bytes32 creatorPublicKey);
    event MemberJoined(uint256 indexed roomId, address indexed member, bytes32 memberPublicKey);

    // ============ 数据结构 ============

    struct Room {
        uint256 id;
        address creator;
        string name;
        uint256 createdAt;
    }

    struct Member {
        address addr;
        bytes32 publicKey;
        uint256 joinedAt;
    }

    // ============ 状态变量 ============

    /// @notice 用户地址 => X25519 公钥（32 字节）
    mapping(address => bytes32) public userPublicKeys;

    /// @notice 房间 ID => 房间信息
    mapping(uint256 => Room) public rooms;

    /// @notice 房间 ID => 成员地址 => 成员信息
    mapping(uint256 => mapping(address => Member)) public roomMembers;

    /// @notice 房间 ID => 成员地址列表
    mapping(uint256 => address[]) public roomMemberList;

    /// @notice 用户 => 已加入的房间 ID 列表
    mapping(address => uint256[]) public userRooms;

    /// @notice 房间数量（用于生成 roomId）
    uint256 public roomCount;

    // ============ 函数 ============

    /**
     * 注册公钥（首次连接钱包后调用）
     * @param publicKey X25519 公钥（32 字节）
     */
    function registerPublicKey(bytes32 publicKey) external {
        require(publicKey != bytes32(0), "Invalid public key");
        userPublicKeys[msg.sender] = publicKey;
        emit PublicKeyRegistered(msg.sender, publicKey);
    }

    /**
     * 创建房间
     * @param name 房间名称
     * @param publicKey 创建者的 X25519 公钥
     * @return roomId 新创建的房间 ID
     */
    function createRoom(string calldata name, bytes32 publicKey) external returns (uint256) {
        require(bytes(name).length > 0, "Room name empty");
        require(publicKey != bytes32(0), "Invalid public key");

        // 自动注册公钥（若未注册）
        if (userPublicKeys[msg.sender] == bytes32(0)) {
            userPublicKeys[msg.sender] = publicKey;
            emit PublicKeyRegistered(msg.sender, publicKey);
        }

        uint256 roomId = roomCount++;
        rooms[roomId] = Room({
            id: roomId,
            creator: msg.sender,
            name: name,
            createdAt: block.timestamp
        });

        // 创建者自动成为第一个成员
        _addMember(roomId, msg.sender, publicKey);

        emit RoomCreated(roomId, msg.sender, name, publicKey);
        return roomId;
    }

    /**
     * 加入房间
     * @param roomId 房间 ID
     * @param publicKey 加入者的 X25519 公钥
     */
    function joinRoom(uint256 roomId, bytes32 publicKey) external {
        require(roomId < roomCount, "Room not found");
        require(publicKey != bytes32(0), "Invalid public key");
        require(roomMembers[roomId][msg.sender].addr == address(0), "Already joined");

        // 自动注册公钥（若未注册）
        if (userPublicKeys[msg.sender] == bytes32(0)) {
            userPublicKeys[msg.sender] = publicKey;
            emit PublicKeyRegistered(msg.sender, publicKey);
        }

        _addMember(roomId, msg.sender, publicKey);
        emit MemberJoined(roomId, msg.sender, publicKey);
    }

    /**
     * 获取房间成员地址列表
     * @param roomId 房间 ID
     * @return 成员地址数组
     */
    function getMembers(uint256 roomId) external view returns (address[] memory) {
        require(roomId < roomCount, "Room not found");
        return roomMemberList[roomId];
    }

    /**
     * 获取房间成员的公钥列表（用于 ECDH 密钥协商）
     * @param roomId 房间 ID
     * @return addresses 成员地址数组
     * @return publicKeys 对应的 X25519 公钥数组
     */
    function getMemberPublicKeys(uint256 roomId)
        external
        view
        returns (address[] memory addresses, bytes32[] memory publicKeys)
    {
        require(roomId < roomCount, "Room not found");
        address[] storage members = roomMemberList[roomId];
        uint256 len = members.length;
        addresses = new address[](len);
        publicKeys = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            address memberAddr = members[i];
            addresses[i] = memberAddr;
            publicKeys[i] = roomMembers[roomId][memberAddr].publicKey;
        }
    }

    /**
     * 获取用户已加入的房间列表
     * @param user 用户地址
     * @return 房间 ID 数组
     */
    function getUserRooms(address user) external view returns (uint256[] memory) {
        return userRooms[user];
    }

    /**
     * 获取房间信息
     * @param roomId 房间 ID
     * @return id 房间 ID
     * @return creator 创建者地址
     * @return name 房间名称
     * @return createdAt 创建时间
     */
    function getRoom(uint256 roomId)
        external
        view
        returns (uint256 id, address creator, string memory name, uint256 createdAt)
    {
        require(roomId < roomCount, "Room not found");
        Room storage room = rooms[roomId];
        return (room.id, room.creator, room.name, room.createdAt);
    }

    /**
     * 获取房间成员数量
     */
    function getMemberCount(uint256 roomId) external view returns (uint256) {
        require(roomId < roomCount, "Room not found");
        return roomMemberList[roomId].length;
    }

    // ============ 内部函数 ============

    function _addMember(uint256 roomId, address member, bytes32 publicKey) internal {
        roomMembers[roomId][member] = Member({
            addr: member,
            publicKey: publicKey,
            joinedAt: block.timestamp
        });
        roomMemberList[roomId].push(member);
        userRooms[member].push(roomId);
    }
}
