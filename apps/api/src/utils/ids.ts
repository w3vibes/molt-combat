import { stableHash } from './hash.js';

export function toMatchIdHex(id: string): string {
  return `0x${stableHash(id)}`;
}
