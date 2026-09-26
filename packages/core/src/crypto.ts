import { readFileSync, statSync } from "node:fs";

const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function unb64(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, "base64url")); }

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Buffer.from(digest).toString("hex");
}

/** The key file is outside SQL and outside the artifact directory. */
export class SecretBox {
  private constructor(private readonly key: CryptoKey) {}
  static async fromFile(path: string): Promise<SecretBox> {
    const stat = statSync(path);
    if ((stat.mode & 0o077) !== 0) throw new Error("Encryption key file must not be accessible to group or others");
    const contents = readFileSync(path);
    const raw = contents.length === 32 ? contents : Buffer.from(contents.toString("utf8").trim(), "base64");
    if (raw.length !== 32) throw new Error("Encryption key must contain exactly 32 bytes or their base64 encoding");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new SecretBox(key);
  }
  async seal(purpose: string, resourceId: string, plaintext: string): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = encoder.encode(`${purpose}:${resourceId}:v1`);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, this.key, encoder.encode(plaintext));
    return `v1.${b64(nonce)}.${b64(new Uint8Array(ciphertext))}`;
  }
  async open(purpose: string, resourceId: string, sealed: string): Promise<string> {
    const [version, nonce, ciphertext, extra] = sealed.split(".");
    if (version !== "v1" || !nonce || !ciphertext || extra) throw new Error("Unsupported encrypted payload");
    const aad = encoder.encode(`${purpose}:${resourceId}:v1`);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(nonce) as BufferSource, additionalData: aad }, this.key, unb64(ciphertext) as BufferSource);
    return new TextDecoder().decode(bytes);
  }
}
