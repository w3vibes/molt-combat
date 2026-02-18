// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {MoltPrizePool} from "../src/MoltPrizePool.sol";

contract MoltPrizePoolTest is Test {
    MoltPrizePool pool;
    address winner = address(0xBEEF);

    function setUp() public {
        pool = new MoltPrizePool();
    }

    function testFundAndPayout() public {
        bytes32 matchId = keccak256("match");

        pool.fundMatch{value: 1 ether}(matchId);
        assertEq(pool.prizeByMatch(matchId), 1 ether);

        uint256 beforeBalance = winner.balance;
        pool.payoutWinner(matchId, payable(winner));

        assertEq(pool.prizeByMatch(matchId), 0);
        assertEq(winner.balance, beforeBalance + 1 ether);
    }
}
