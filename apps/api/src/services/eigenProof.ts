import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import type { AgentAction } from '../types/domain.js';
import { stableHash } from '../utils/hash.js';

export type EigenTurnProof = {
  version?: string;
  challenge: string;
  actionHash: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  signer: string;
  signature: string;
  timestamp: string;
};

export type ExpectedEigenTurnBinding = {
  required: boolean;
  matchId: string;
  turn: number;
  agentId: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
};

export type EigenTurnProofVerification = {
  valid: boolean;
  recoveredAddress?: string;
  reason?: string;
};

function normalize(value: string | undefined): string {
  return (value || '').trim();
}

function normalizeLower(value: string | undefined): string {
  return normalize(value).toLowerCase();
}

function normalizeHexAddress(value: string | undefined): string {
  const normalized = normalizeLower(value);
  return normalized.startsWith('0x') ? normalized : normalized ? `0x${normalized}` : '';
}

function parseTimeMs(timestamp: string): number {
  const asNumber = Number(timestamp);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function proofVersion(input?: string): string {
  const normalized = normalizeLower(input);
  return normalized || 'v1';
}

export function eigenTurnProofRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_EIGEN_TURN_PROOF !== 'false';
}

export function eigenSignerRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_EIGEN_SIGNER_ADDRESS !== 'false';
}

export function eigenTurnProofMaxSkewMs(): number {
  const raw = Number(process.env.MATCH_EIGEN_TURN_PROOF_MAX_SKEW_MS || 5 * 60 * 1000);
  if (!Number.isFinite(raw) || raw <= 0) return 5 * 60 * 1000;
  return Math.min(Math.floor(raw), 60 * 60 * 1000);
}

export function newTurnProofChallenge(): string {
  return randomBytes(20).toString('hex');
}

export function expectedActionHash(action: AgentAction): string {
  return stableHash(action);
}

export function turnProofMessage(input: {
  version?: string;
  matchId: string;
  turn: number;
  agentId: string;
  challenge: string;
  actionHash: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  timestamp: string;
}): string {
  return [
    'MOLT_COMBAT_EIGEN_TURN_PROOF',
    proofVersion(input.version),
    input.matchId,
    String(input.turn),
    input.agentId,
    input.challenge,
    normalizeLower(input.actionHash),
    normalizeHexAddress(input.appId),
    normalizeLower(input.environment),
    normalizeLower(input.imageDigest),
    input.timestamp
  ].join('|');
}

export function verifyEigenTurnProof(input: {
  action: AgentAction;
  proof: EigenTurnProof;
  expected: ExpectedEigenTurnBinding;
  challenge: string;
  maxSkewMs?: number;
}): EigenTurnProofVerification {
  const expectedAction = expectedActionHash(input.action);

  if (normalizeLower(input.proof.actionHash) !== normalizeLower(expectedAction)) {
    return { valid: false, reason: 'proof_action_hash_mismatch' };
  }

  if (normalizeLower(input.proof.challenge) !== normalizeLower(input.challenge)) {
    return { valid: false, reason: 'proof_challenge_mismatch' };
  }

  if (normalizeHexAddress(input.proof.appId) !== normalizeHexAddress(input.expected.appId)) {
    return { valid: false, reason: 'proof_app_id_mismatch' };
  }

  if (input.expected.environment) {
    if (normalizeLower(input.proof.environment) !== normalizeLower(input.expected.environment)) {
      return { valid: false, reason: 'proof_environment_mismatch' };
    }
  }

  if (input.expected.imageDigest) {
    if (normalizeLower(input.proof.imageDigest) !== normalizeLower(input.expected.imageDigest)) {
      return { valid: false, reason: 'proof_image_digest_mismatch' };
    }
  }

  const timestampMs = parseTimeMs(input.proof.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return { valid: false, reason: 'proof_timestamp_invalid' };
  }

  const maxSkew = input.maxSkewMs ?? eigenTurnProofMaxSkewMs();
  if (Math.abs(Date.now() - timestampMs) > maxSkew) {
    return { valid: false, reason: 'proof_timestamp_out_of_window' };
  }

  const message = turnProofMessage({
    version: input.proof.version,
    matchId: input.expected.matchId,
    turn: input.expected.turn,
    agentId: input.expected.agentId,
    challenge: input.challenge,
    actionHash: expectedAction,
    appId: input.expected.appId,
    environment: input.expected.environment,
    imageDigest: input.expected.imageDigest,
    timestamp: input.proof.timestamp
  });

  try {
    const recovered = ethers.verifyMessage(message, input.proof.signature);
    const recoveredLower = normalizeLower(recovered);

    if (normalizeLower(input.proof.signer) && recoveredLower !== normalizeLower(input.proof.signer)) {
      return {
        valid: false,
        recoveredAddress: recovered,
        reason: 'proof_signer_mismatch'
      };
    }

    if (input.expected.signerAddress && recoveredLower !== normalizeLower(input.expected.signerAddress)) {
      return {
        valid: false,
        recoveredAddress: recovered,
        reason: 'proof_signer_not_allowed'
      };
    }

    return {
      valid: true,
      recoveredAddress: recovered
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? `proof_signature_invalid:${error.message}` : 'proof_signature_invalid'
    };
  }
}
