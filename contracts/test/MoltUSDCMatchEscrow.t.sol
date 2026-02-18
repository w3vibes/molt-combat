// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {MoltUSDCMatchEscrow} from "../src/MoltUSDCMatchEscrow.sol";

contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "NO_BAL");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "NO_BAL");
        require(allowance[from][msg.sender] >= amount, "NO_ALLOW");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MoltUSDCMatchEscrowTest is Test {
    MockUSDC usdc;
    MoltUSDCMatchEscrow escrow;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address feeTo = address(0xFEE);

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new MoltUSDCMatchEscrow(address(usdc), feeTo, 300); // 3%

        usdc.mint(alice, 2_000_000); // 2 USDC (6dp)
        usdc.mint(bob, 2_000_000);

        vm.startPrank(alice);
        usdc.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function testCreateDepositSettle() public {
        bytes32 matchId = keccak256("molt-usdc-1");
        escrow.createMatch(matchId, alice, bob, 1_000_000); // 1 USDC each

        vm.prank(alice);
        escrow.deposit(matchId);

        vm.prank(bob);
        escrow.deposit(matchId);

        escrow.settle(matchId, alice);

        // gross = 2,000,000 ; fee=60,000 ; winner=1,940,000
        assertEq(usdc.balanceOf(feeTo), 60_000);
        assertEq(usdc.balanceOf(alice), 2_940_000);
        assertEq(usdc.balanceOf(bob), 1_000_000);
    }

    function testRevertSamePlayer() public {
        bytes32 matchId = keccak256("same-player");
        vm.expectRevert("SAME_PLAYER");
        escrow.createMatch(matchId, alice, alice, 1_000_000);
    }
}

