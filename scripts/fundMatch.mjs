import { ethers } from 'ethers';
import crypto from 'node:crypto';

const [,, matchId, contractAddress, amountEth] = process.argv;
if (!matchId || !contractAddress || !amountEth) {
  console.error('Usage: node scripts/fundMatch.mjs <matchId> <contractAddress> <amountEth>');
  process.exit(1);
}

const rpc = process.env.SEPOLIA_RPC_URL;
const key = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
if (!rpc || !key) throw new Error('Missing SEPOLIA_RPC_URL or signer key');

const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(key, provider);
const abi = ['function fundMatch(bytes32 matchId) external payable'];
const contract = new ethers.Contract(contractAddress, abi, wallet);
// must match API stableHash(JSON.stringify(id)) semantics
const matchIdHex = '0x' + crypto.createHash('sha256').update(JSON.stringify(matchId)).digest('hex');

const tx = await contract.fundMatch(matchIdHex, { value: ethers.parseEther(amountEth) });
console.log('fund tx:', tx.hash);
await tx.wait();
console.log('funded match', matchId, 'as', matchIdHex);
