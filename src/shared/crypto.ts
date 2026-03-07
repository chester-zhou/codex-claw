import { randomBytes, randomUUID, verify } from "node:crypto";

export function createChallenge(): { challengeId: string; challenge: string } {
  return {
    challengeId: randomUUID(),
    challenge: randomUUID(),
  };
}

export function createPairingCode(): string {
  return randomBytes(4).toString("hex");
}

export function verifySignature(
  publicKeyPem: string,
  challenge: string,
  signatureBase64: string,
): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(challenge, "utf8"),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
