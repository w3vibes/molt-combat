import { ethers } from 'ethers';

const ESCROW_ABI = [
  'function createMatch(bytes32 matchId, address playerA, address playerB, uint256 amountPerPlayer) external',
  'function settle(bytes32 matchId, address winner) external',
  'function getMatch(bytes32 matchId) view returns (address playerA, address playerB, uint256 amountPerPlayer, bool settled, bool playerADeposited, bool playerBDeposited)'
];

function withSigner(rpcUrl: string, privateKey: string, contractAddress: string) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  return new ethers.Contract(contractAddress, ESCROW_ABI, wallet);
}

function withProvider(rpcUrl: string, contractAddress: string) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(contractAddress, ESCROW_ABI, provider);
}

export async function createEscrowMatch(params: {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  matchIdHex: string;
  playerA: string;
  playerB: string;
  amountPerPlayer: string;
}) {
  const contract = withSigner(params.rpcUrl, params.privateKey, params.contractAddress);
  const tx = await contract.createMatch(
    params.matchIdHex,
    params.playerA,
    params.playerB,
    BigInt(params.amountPerPlayer)
  );
  return tx.wait();
}

export async function settleEscrowMatch(params: {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  matchIdHex: string;
  winner: string;
}) {
  const contract = withSigner(params.rpcUrl, params.privateKey, params.contractAddress);
  const tx = await contract.settle(params.matchIdHex, params.winner);
  return tx.wait();
}

export async function getEscrowMatchStatus(params: {
  rpcUrl: string;
  contractAddress: string;
  matchIdHex: string;
}) {
  const contract = withProvider(params.rpcUrl, params.contractAddress);
  const [playerA, playerB, amountPerPlayer, settled, playerADeposited, playerBDeposited] = await contract.getMatch(params.matchIdHex);

  return {
    playerA,
    playerB,
    amountPerPlayer: amountPerPlayer.toString(),
    settled,
    playerADeposited,
    playerBDeposited
  };
}
