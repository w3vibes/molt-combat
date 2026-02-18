// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {MoltUSDCMatchEscrow} from "../src/MoltUSDCMatchEscrow.sol";

contract DeployMoltUSDCMatchEscrow is Script {
    function run() external returns (MoltUSDCMatchEscrow deployed) {
        uint256 key = uint256(vm.envBytes32("PAYOUT_SIGNER_PRIVATE_KEY"));
        address usdc = vm.envAddress("USDC_TOKEN_ADDRESS");
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        uint256 feeBps = vm.envUint("FEE_BPS");

        vm.startBroadcast(key);
        deployed = new MoltUSDCMatchEscrow(usdc, feeTo, feeBps);
        vm.stopBroadcast();

        console2.log("MoltUSDCMatchEscrow deployed:", address(deployed));
    }
}
