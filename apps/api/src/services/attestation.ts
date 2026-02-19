import { ethers } from 'ethers';
import { MatchAttestationPayload, MatchAttestationRecord, MatchRecord } from '../types/domain.js';
import { stableHash } from '../utils/hash.js';

function signerPrivateKey(): string | undefined {
  return (
    process.env.MATCH_ATTESTATION_SIGNER_PRIVATE_KEY ||
    process.env.PAYOUT_SIGNER_PRIVATE_KEY ||
    process.env.OPERATOR_PRIVATE_KEY
  )?.trim();
}

function payloadForMatch(match: MatchRecord): MatchAttestationPayload {
  const fairness = match.audit?.fairness;
  const executionMode = fairness?.executionMode ?? 'unknown';
  const strictVerified =
    fairness?.strictVerified === true &&
    fairness.executionMode === 'endpoint' &&
    (!fairness.endpointExecutionRequired || fairness.endpointExecutionPassed === true) &&
    (!fairness.sandboxParityEnforced || fairness.sandboxParityPassed === true) &&
    (!fairness.eigenComputeEnforced || fairness.eigenComputePassed === true);

  return {
    matchId: match.id,
    startedAt: match.startedAt,
    turnsPlayed: match.turnsPlayed,
    winner: match.winner ?? '',
    scorecardHash: match.scorecardHash ?? '',
    replayHash: stableHash(match.replay),
    auditHash: stableHash(match.audit ?? null),
    agentIds: match.agents.map((agent) => agent.id),
    executionMode,
    strictVerified
  };
}

function payloadHash(payload: MatchAttestationPayload): string {
  return stableHash(payload);
}

function messageBytes(hashHex: string): Uint8Array {
  return ethers.getBytes(`0x${hashHex}`);
}

export function attestationSignerAddress(): string | null {
  const key = signerPrivateKey();
  if (!key) return null;
  return new ethers.Wallet(key).address;
}

export async function signMatchAttestation(match: MatchRecord): Promise<MatchAttestationRecord | null> {
  const key = signerPrivateKey();
  if (!key) return null;

  const payload = payloadForMatch(match);
  const hash = payloadHash(payload);
  const wallet = new ethers.Wallet(key);
  const signature = await wallet.signMessage(messageBytes(hash));

  return {
    matchId: match.id,
    signerAddress: wallet.address,
    signature,
    signatureType: 'eip191',
    payloadHash: hash,
    payload,
    createdAt: new Date().toISOString()
  };
}

export type AttestationVerification = {
  valid: boolean;
  recoveredAddress?: string;
  reason?: string;
  payloadMatchesMatch?: boolean;
};

export function verifyMatchAttestation(
  attestation: MatchAttestationRecord,
  expectedMatch?: MatchRecord
): AttestationVerification {
  try {
    const derivedHash = payloadHash(attestation.payload);
    if (derivedHash !== attestation.payloadHash) {
      return { valid: false, reason: 'payload_hash_mismatch' };
    }

    const recovered = ethers.verifyMessage(
      messageBytes(attestation.payloadHash),
      attestation.signature
    );

    if (recovered.toLowerCase() !== attestation.signerAddress.toLowerCase()) {
      return {
        valid: false,
        recoveredAddress: recovered,
        reason: 'signer_mismatch'
      };
    }

    if (expectedMatch) {
      const expectedPayload = payloadForMatch(expectedMatch);
      const expectedHash = payloadHash(expectedPayload);
      if (expectedHash !== attestation.payloadHash) {
        return {
          valid: false,
          recoveredAddress: recovered,
          reason: 'match_payload_mismatch',
          payloadMatchesMatch: false
        };
      }
      return { valid: true, recoveredAddress: recovered, payloadMatchesMatch: true };
    }

    return { valid: true, recoveredAddress: recovered };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'verification_error'
    };
  }
}
