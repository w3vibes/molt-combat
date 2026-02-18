import { ethers } from 'ethers';

const [,, escrowContract, matchIdHex] = process.argv;
if (!escrowContract || !matchIdHex) {
  console.error('Usage: node scripts/escrowStatus.mjs <ESCROW_CONTRACT_ADDRESS> <MATCH_ID_HEX>');
  process.exit(1);
}

const rpcUrl = process.env.SEPOLIA_RPC_URL;
if (!rpcUrl) throw new Error('Missing SEPOLIA_RPC_URL');

const provider = new ethers.JsonRpcProvider(rpcUrl);
const abi = [
  'function getMatch(bytes32 matchId) view returns (address playerA, address playerB, uint256 amountPerPlayer, bool settled, bool playerADeposited, bool playerBDeposited)'
];
const escrow = new ethers.Contract(escrowContract, abi, provider);

const [playerA, playerB, amountPerPlayer, settled, playerADeposited, playerBDeposited] = await escrow.getMatch(matchIdHex);

console.log(JSON.stringify({
  playerA,
  playerB,
  amountPerPlayer: amountPerPlayer.toString(),
  settled,
  playerADeposited,
  playerBDeposited
}, null, 2));
