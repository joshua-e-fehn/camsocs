/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Digests first so the loop bound is fixed and the supplied key's length is not
 * observable either. `crypto.subtle` is ambient in Convex's V8 runtime (queries,
 * mutations and HTTP actions alike); `node:crypto` would force `"use node"`,
 * which an httpAction cannot use.
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ])
  const bytesA = new Uint8Array(digestA)
  const bytesB = new Uint8Array(digestB)
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i]
  }
  return diff === 0
}
