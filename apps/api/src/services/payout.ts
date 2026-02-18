import { ethers } from 'ethers';

const ABI = [
  'function payoutWinner(bytes32 matchId, address winner) external',
  'function fundMatch(bytes32 matchId) external payable'
];

function getContract(params: { contractAddress: string; privateKey: string; rpcUrl: string }) {
  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const wallet = new ethers.Wallet(params.privateKey, provider);
  return new ethers.Contract(params.contractAddress, ABI, wallet);
}

export async function payoutOnSepolia(params: { contractAddress: string; privateKey: string; rpcUrl: string; matchIdHex: string; winner: string }) {
  const contract = getContract(params);
  const tx = await contract.payoutWinner(params.matchIdHex, params.winner);
  return tx.wait();
}

export async function fundOnSepolia(params: { contractAddress: string; privateKey: string; rpcUrl: string; matchIdHex: string; amountEth: string }) {
  const contract = getContract(params);
  const tx = await contract.fundMatch(params.matchIdHex, { value: ethers.parseEther(params.amountEth) });
  return tx.wait();
}
