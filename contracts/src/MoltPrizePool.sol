// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MoltPrizePool {
    address public owner;

    struct MatchPayout {
        bytes32 matchId;
        address winner;
        uint256 amount;
        bool paid;
    }

    mapping(bytes32 => uint256) public prizeByMatch;
    mapping(bytes32 => MatchPayout) public payouts;

    event PrizeFunded(bytes32 indexed matchId, uint256 amount);
    event PrizePaid(bytes32 indexed matchId, address indexed winner, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() { owner = msg.sender; }

    function fundMatch(bytes32 matchId) external payable {
        require(msg.value > 0, "NO_VALUE");
        prizeByMatch[matchId] += msg.value;
        emit PrizeFunded(matchId, msg.value);
    }

    function payoutWinner(bytes32 matchId, address payable winner) external onlyOwner {
        uint256 amount = prizeByMatch[matchId];
        require(amount > 0, "NO_PRIZE");
        require(!payouts[matchId].paid, "ALREADY_PAID");
        payouts[matchId] = MatchPayout(matchId, winner, amount, true);
        prizeByMatch[matchId] = 0;
        (bool ok, ) = winner.call{value: amount}("");
        require(ok, "TRANSFER_FAILED");
        emit PrizePaid(matchId, winner, amount);
    }
}
