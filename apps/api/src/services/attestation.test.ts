import { afterEach, describe, expect, it } from 'vitest';
import { signMatchAttestation, verifyMatchAttestation } from './attestation.js';
import { MatchRecord } from '../types/domain.js';

const TEST_KEY = '0x59c6995e998f97a5a0044976f7d5deabf5b2f0b8fda9b3d9e2f7f9d4d7d5b8d1';

function sampleMatch(): MatchRecord {
  return {
    id: 'match_1',
    status: 'finished',
    startedAt: new Date().toISOString(),
    turnsPlayed: 2,
    winner: 'a1',
    scorecardHash: 'abc123',
    agents: [
      { id: 'a1', name: 'Alpha', endpoint: 'https://alpha.example.com' },
      { id: 'a2', name: 'Beta', endpoint: 'https://beta.example.com' }
    ],
    replay: [
      { turn: 1, actions: { a1: { type: 'hold' }, a2: { type: 'hold' } }, states: [] },
      { turn: 2, actions: { a1: { type: 'hold' }, a2: { type: 'hold' } }, states: [] }
    ],
    config: { maxTurns: 10, seed: 1, attackCost: 1, attackDamage: 4 }
  };
}

afterEach(() => {
  delete process.env.MATCH_ATTESTATION_SIGNER_PRIVATE_KEY;
});

describe('match attestations', () => {
  it('signs and verifies attestation against the expected match payload', async () => {
    process.env.MATCH_ATTESTATION_SIGNER_PRIVATE_KEY = TEST_KEY;
    const match = sampleMatch();

    const attestation = await signMatchAttestation(match);
    expect(attestation).toBeTruthy();

    const verification = verifyMatchAttestation(attestation!, match);
    expect(verification.valid).toBe(true);
    expect(verification.payloadMatchesMatch).toBe(true);
  });

  it('rejects tampered payloads', async () => {
    process.env.MATCH_ATTESTATION_SIGNER_PRIVATE_KEY = TEST_KEY;
    const match = sampleMatch();

    const attestation = await signMatchAttestation(match);
    expect(attestation).toBeTruthy();

    const tampered = {
      ...attestation!,
      payload: {
        ...attestation!.payload,
        winner: 'a2'
      }
    };

    const verification = verifyMatchAttestation(tampered, match);
    expect(verification.valid).toBe(false);
  });
});
