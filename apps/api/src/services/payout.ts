import { ethers } from 'ethers';

const ABI = [
  'function payoutWinner(bytes32 matchId, address winner) external',
  'function fundMatch(bytes32 matchId) external payable',
  'function prizeByMatch(bytes32 matchId) view returns (uint256)',
  'function payouts(bytes32 matchId) view returns (bytes32 matchIdOut, address winner, uint256 amount, bool paid)'
];

function getContract(params: { contractAddress: string; privateKey: string; rpcUrl: string }) {
  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const wallet = new ethers.Wallet(params.privateKey, provider);
  return new ethers.Contract(params.contractAddress, ABI, wallet);
}

function getReadContract(params: { contractAddress: string; rpcUrl: string }) {
  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  return new ethers.Contract(params.contractAddress, ABI, provider);
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

export async function getPrizePoolMatchStatus(params: { contractAddress: string; rpcUrl: string; matchIdHex: string }) {
  const contract = getReadContract(params);

  const [fundedAmountWeiRaw, payoutRaw] = await Promise.all([
    contract.prizeByMatch(params.matchIdHex),
    contract.payouts(params.matchIdHex)
  ]);

  const fundedAmountWei = BigInt(fundedAmountWeiRaw ?? 0n).toString();
  const payoutTuple = payoutRaw as [string, string, bigint, boolean];
  const paid = Boolean(payoutTuple?.[3]);
  const paidWinner = String(payoutTuple?.[1] || ethers.ZeroAddress);
  const paidAmountWei = BigInt(payoutTuple?.[2] ?? 0n).toString();

  return {
    fundedAmountWei,
    paid,
    paidWinner,
    paidAmountWei
  };
}
