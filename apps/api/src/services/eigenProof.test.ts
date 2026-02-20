import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  EigenTurnProof,
  turnProofMessage,
  verifyEigenTurnProof
} from './eigenProof.js';
import { stableHash } from '../utils/hash.js';

const TEST_KEY = '0x59c6995e998f97a5a0044976f7d5deabf5b2f0b8fda9b3d9e2f7f9d4d7d5b8d1';

describe('eigen turn proofs', () => {
  it('verifies valid signed turn proof', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const action = { type: 'hold' } as const;
    const challenge = 'proof_challenge_1234567890';
    const timestamp = new Date().toISOString();
    const actionHash = stableHash(action);

    const message = turnProofMessage({
      version: 'v1',
      matchId: 'match_123',
      turn: 1,
      agentId: 'a1',
      challenge,
      actionHash,
      appId: '0x1111111111111111111111111111111111111111',
      environment: 'sepolia',
      imageDigest: 'sha256:abc',
      timestamp
    });

    const signature = await wallet.signMessage(message);

    const proof: EigenTurnProof = {
      version: 'v1',
      challenge,
      actionHash,
      appId: '0x1111111111111111111111111111111111111111',
      environment: 'sepolia',
      imageDigest: 'sha256:abc',
      signer: wallet.address,
      signature,
      timestamp
    };

    const result = verifyEigenTurnProof({
      action,
      proof,
      expected: {
        required: true,
        matchId: 'match_123',
        turn: 1,
        agentId: 'a1',
        appId: '0x1111111111111111111111111111111111111111',
        environment: 'sepolia',
        imageDigest: 'sha256:abc',
        signerAddress: wallet.address
      },
      challenge
    });

    expect(result.valid).toBe(true);
  });

  it('rejects proof when challenge mismatches', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const action = { type: 'hold' } as const;
    const challenge = 'proof_challenge_1234567890';
    const timestamp = new Date().toISOString();
    const actionHash = stableHash(action);

    const message = turnProofMessage({
      version: 'v1',
      matchId: 'match_123',
      turn: 1,
      agentId: 'a1',
      challenge,
      actionHash,
      appId: '0x1111111111111111111111111111111111111111',
      environment: 'sepolia',
      imageDigest: 'sha256:abc',
      timestamp
    });

    const signature = await wallet.signMessage(message);

    const proof: EigenTurnProof = {
      version: 'v1',
      challenge,
      actionHash,
      appId: '0x1111111111111111111111111111111111111111',
      environment: 'sepolia',
      imageDigest: 'sha256:abc',
      signer: wallet.address,
      signature,
      timestamp
    };

    const result = verifyEigenTurnProof({
      action,
      proof,
      expected: {
        required: true,
        matchId: 'match_123',
        turn: 1,
        agentId: 'a1',
        appId: '0x1111111111111111111111111111111111111111',
        environment: 'sepolia',
        imageDigest: 'sha256:abc',
        signerAddress: wallet.address
      },
      challenge: 'different_challenge'
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('proof_challenge_mismatch');
  });
});
