// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {MoltPrizePool} from "../src/MoltPrizePool.sol";

contract DeployMoltPrizePool is Script {
    function run() external returns (MoltPrizePool deployed) {
        uint256 key = uint256(vm.envBytes32("PAYOUT_SIGNER_PRIVATE_KEY"));
        vm.startBroadcast(key);
        deployed = new MoltPrizePool();
        vm.stopBroadcast();
        console2.log("MoltPrizePool deployed:", address(deployed));
    }
}
