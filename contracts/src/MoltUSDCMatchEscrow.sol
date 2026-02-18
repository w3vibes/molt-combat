// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MoltUSDCMatchEscrow {
    address public owner;
    IERC20 public immutable usdc;
    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    struct Stake {
        address playerA;
        address playerB;
        uint256 amountPerPlayer;
        bool settled;
        mapping(address => bool) deposited;
    }

    mapping(bytes32 => Stake) private stakes;

    event MatchCreated(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint256 amountPerPlayer);
    event Deposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Settled(bytes32 indexed matchId, address indexed winner, uint256 winnerAmount, uint256 feeAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address usdcToken, address feeTo, uint256 feeBasisPoints) {
        require(usdcToken != address(0), "ZERO_USDC");
        require(feeTo != address(0), "ZERO_FEE_TO");
        require(feeBasisPoints <= 1000, "FEE_TOO_HIGH");
        owner = msg.sender;
        usdc = IERC20(usdcToken);
        feeRecipient = feeTo;
        feeBps = feeBasisPoints;
    }

    function createMatch(bytes32 matchId, address playerA, address playerB, uint256 amountPerPlayer) external onlyOwner {
        Stake storage s = stakes[matchId];
        require(s.playerA == address(0), "MATCH_EXISTS");
        require(playerA != address(0) && playerB != address(0), "ZERO_PLAYER");
        require(playerA != playerB, "SAME_PLAYER");
        require(amountPerPlayer > 0, "ZERO_STAKE");

        s.playerA = playerA;
        s.playerB = playerB;
        s.amountPerPlayer = amountPerPlayer;

        emit MatchCreated(matchId, playerA, playerB, amountPerPlayer);
    }

    function deposit(bytes32 matchId) external {
        Stake storage s = stakes[matchId];
        require(s.playerA != address(0), "MATCH_NOT_FOUND");
        require(!s.settled, "SETTLED");
        require(msg.sender == s.playerA || msg.sender == s.playerB, "NOT_PLAYER");
        require(!s.deposited[msg.sender], "ALREADY_DEPOSITED");

        s.deposited[msg.sender] = true;
        require(usdc.transferFrom(msg.sender, address(this), s.amountPerPlayer), "TRANSFER_FROM_FAILED");
        emit Deposited(matchId, msg.sender, s.amountPerPlayer);
    }

    function settle(bytes32 matchId, address winner) external onlyOwner {
        Stake storage s = stakes[matchId];
        require(s.playerA != address(0), "MATCH_NOT_FOUND");
        require(!s.settled, "ALREADY_SETTLED");
        require(s.deposited[s.playerA] && s.deposited[s.playerB], "NOT_FULLY_FUNDED");
        require(winner == s.playerA || winner == s.playerB, "INVALID_WINNER");

        s.settled = true;
        uint256 gross = s.amountPerPlayer * 2;
        uint256 feeAmount = (gross * feeBps) / 10_000;
        uint256 winnerAmount = gross - feeAmount;

        if (feeAmount > 0) {
            require(usdc.transfer(feeRecipient, feeAmount), "FEE_TRANSFER_FAILED");
        }
        require(usdc.transfer(winner, winnerAmount), "WINNER_TRANSFER_FAILED");

        emit Settled(matchId, winner, winnerAmount, feeAmount);
    }

    function getMatch(bytes32 matchId)
        external
        view
        returns (address playerA, address playerB, uint256 amountPerPlayer, bool settled, bool playerADeposited, bool playerBDeposited)
    {
        Stake storage s = stakes[matchId];
        return (s.playerA, s.playerB, s.amountPerPlayer, s.settled, s.deposited[s.playerA], s.deposited[s.playerB]);
    }
}
