// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PrivateChatRoom} from "../PrivateChatRoom.sol";

/**
 * PrivateChatRoom contract tests
 * Covers: create room, join room, duplicate join, non-member call, public key registration, queries
 *
 * Note: Must use Monad Foundry fork to run tests
 * Install: https://docs.monad.xyz/tooling-and-infra/toolkits/monad-foundry
 * Run: forge test --chain-id 10143
 */
contract PrivateChatRoomTest is Test {
    PrivateChatRoom public chatRoom;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");

    bytes32 public alicePubKey = keccak256("alice_pubkey");
    bytes32 public bobPubKey = keccak256("bob_pubkey");
    bytes32 public carolPubKey = keccak256("carol_pubkey");

    function setUp() public {
        chatRoom = new PrivateChatRoom();
    }

    // ============ registerPublicKey tests ============

    function test_RegisterPublicKey() public {
        vm.prank(alice);
        chatRoom.registerPublicKey(alicePubKey);

        bytes32 stored = chatRoom.userPublicKeys(alice);
        assertEq(stored, alicePubKey, "public key not stored correctly");
    }

    function testRevert_RegisterEmptyPublicKey() public {
        vm.prank(alice);
        vm.expectRevert("Invalid public key");
        chatRoom.registerPublicKey(bytes32(0));
    }

    // ============ createRoom tests ============

    function test_CreateRoom() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        assertEq(roomId, 0, "first room id should be 0");
        assertEq(chatRoom.roomCount(), 1, "room count should be 1");

        (uint256 id, address creator, string memory name, uint256 createdAt) = chatRoom.getRoom(roomId);
        assertEq(id, 0, "room id mismatch");
        assertEq(creator, alice, "creator mismatch");
        assertEq(name, "Test Room", "name mismatch");
        assertGt(createdAt, 0, "createdAt should be > 0");
    }

    function test_CreateRoomAutoRegistersPublicKey() public {
        vm.prank(alice);
        chatRoom.createRoom("Test Room", alicePubKey);

        bytes32 stored = chatRoom.userPublicKeys(alice);
        assertEq(stored, alicePubKey, "should auto-register public key on createRoom");
    }

    function test_CreateRoomDoesNotOverwritePublicKey() public {
        vm.prank(alice);
        chatRoom.registerPublicKey(alicePubKey);

        bytes32 differentKey = keccak256("different");
        vm.prank(alice);
        chatRoom.createRoom("Test Room", differentKey);

        bytes32 stored = chatRoom.userPublicKeys(alice);
        assertEq(stored, alicePubKey, "existing public key should not be overwritten");
    }

    function testRevert_CreateRoomEmptyName() public {
        vm.prank(alice);
        vm.expectRevert("Room name empty");
        chatRoom.createRoom("", alicePubKey);
    }

    function testRevert_CreateRoomInvalidPublicKey() public {
        vm.prank(alice);
        vm.expectRevert("Invalid public key");
        chatRoom.createRoom("Test Room", bytes32(0));
    }

    function test_CreateMultipleRooms() public {
        vm.startPrank(alice);
        uint256 room1 = chatRoom.createRoom("Room 1", alicePubKey);
        uint256 room2 = chatRoom.createRoom("Room 2", alicePubKey);
        vm.stopPrank();

        assertEq(room1, 0, "first room id should be 0");
        assertEq(room2, 1, "second room id should be 1");
        assertEq(chatRoom.roomCount(), 2, "room count should be 2");
    }

    // ============ joinRoom tests ============

    function test_JoinRoom() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        vm.prank(bob);
        chatRoom.joinRoom(roomId, bobPubKey);

        address[] memory members = chatRoom.getMembers(roomId);
        assertEq(members.length, 2, "member count should be 2");
        assertEq(members[0], alice, "first member should be alice");
        assertEq(members[1], bob, "second member should be bob");

        (address[] memory addrs, bytes32[] memory pubKeys) = chatRoom.getMemberPublicKeys(roomId);
        assertEq(addrs[1], bob, "address mismatch");
        assertEq(pubKeys[1], bobPubKey, "public key mismatch");
    }

    function test_JoinRoomAutoRegistersPublicKey() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        vm.prank(bob);
        chatRoom.joinRoom(roomId, bobPubKey);

        bytes32 stored = chatRoom.userPublicKeys(bob);
        assertEq(stored, bobPubKey, "should auto-register public key on joinRoom");
    }

    function testRevert_JoinNonExistentRoom() public {
        vm.prank(bob);
        vm.expectRevert("Room not found");
        chatRoom.joinRoom(999, bobPubKey);
    }

    function testRevert_JoinRoomTwice() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        vm.prank(alice);
        vm.expectRevert("Already joined");
        chatRoom.joinRoom(roomId, alicePubKey);
    }

    function testRevert_JoinRoomInvalidPublicKey() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        vm.prank(bob);
        vm.expectRevert("Invalid public key");
        chatRoom.joinRoom(roomId, bytes32(0));
    }

    // ============ query tests ============

    function test_GetMemberCount() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        assertEq(chatRoom.getMemberCount(roomId), 1, "initial member count should be 1");

        vm.prank(bob);
        chatRoom.joinRoom(roomId, bobPubKey);
        assertEq(chatRoom.getMemberCount(roomId), 2, "member count should be 2 after join");
    }

    function test_GetUserRooms() public {
        vm.startPrank(alice);
        uint256 room1 = chatRoom.createRoom("Room 1", alicePubKey);
        uint256 room2 = chatRoom.createRoom("Room 2", alicePubKey);
        vm.stopPrank();

        vm.prank(bob);
        chatRoom.joinRoom(room1, bobPubKey);

        uint256[] memory aliceRooms = chatRoom.getUserRooms(alice);
        assertEq(aliceRooms.length, 2, "alice should have 2 rooms");
        assertEq(aliceRooms[0], room1, "room1 mismatch");
        assertEq(aliceRooms[1], room2, "room2 mismatch");

        uint256[] memory bobRooms = chatRoom.getUserRooms(bob);
        assertEq(bobRooms.length, 1, "bob should have 1 room");
        assertEq(bobRooms[0], room1, "room mismatch");
    }

    function testRevert_GetRoomNotFound() public {
        vm.expectRevert("Room not found");
        chatRoom.getRoom(999);
    }

    function testRevert_GetMembersNotFound() public {
        vm.expectRevert("Room not found");
        chatRoom.getMembers(999);
    }

    // ============ event tests ============

    function test_RoomCreatedEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PrivateChatRoom.RoomCreated(0, alice, "Test Room", alicePubKey);
        chatRoom.createRoom("Test Room", alicePubKey);
    }

    function test_MemberJoinedEvent() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Test Room", alicePubKey);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit PrivateChatRoom.MemberJoined(roomId, bob, bobPubKey);
        chatRoom.joinRoom(roomId, bobPubKey);
    }

    function test_PublicKeyRegisteredEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit PrivateChatRoom.PublicKeyRegistered(alice, alicePubKey);
        chatRoom.registerPublicKey(alicePubKey);
    }

    // ============ multi-member scenario ============

    function test_MultipleMembersJoin() public {
        vm.prank(alice);
        uint256 roomId = chatRoom.createRoom("Big Room", alicePubKey);

        vm.prank(bob);
        chatRoom.joinRoom(roomId, bobPubKey);

        vm.prank(carol);
        chatRoom.joinRoom(roomId, carolPubKey);

        assertEq(chatRoom.getMemberCount(roomId), 3, "member count should be 3");

        (address[] memory addrs, bytes32[] memory pubKeys) = chatRoom.getMemberPublicKeys(roomId);
        assertEq(addrs.length, 3, "addresses length should be 3");
        assertEq(pubKeys[0], alicePubKey, "alice pubkey mismatch");
        assertEq(pubKeys[1], bobPubKey, "bob pubkey mismatch");
        assertEq(pubKeys[2], carolPubKey, "carol pubkey mismatch");
    }
}
