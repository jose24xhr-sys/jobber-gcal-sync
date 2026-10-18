const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64encode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE S256 code_challenge = base64url(sha256(verifier)) without padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
}

/** base64(HMAC-SHA256(secret, rawBody)) — the format Jobber sends in X-Jobber-Hmac-SHA256. */
export async function hmacSha256Base64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64encode(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Constant-time string comparison (does not short-circuit on the first differing byte). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---- AES-GCM for tokens at rest -------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * TOKEN_ENCRYPTION_KEY: ideally 32 random bytes, base64. Any other string (a passphrase) is accepted and
 * stretched to a 256-bit key with SHA-256, so a hand-typed secret still works.
 */
async function rawKeyBytes(secret: string): Promise<Uint8Array> {
  try {
    const raw = b64decode(secret.trim());
    if (raw.length === 32) return raw;
  } catch {
    /* not base64 — treat as passphrase */
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
}

function aesKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
    k = rawKeyBytes(secret).then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keyCache.set(secret, k);
  }
  return k;
}

export async function encryptString(base64Key: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(base64Key), encoder.encode(plaintext));
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

export async function decryptString(base64Key: string, payload: string): Promise<string> {
  const [version, ivB64, ctB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Unrecognized encrypted token format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) },
    await aesKey(base64Key),
    b64decode(ctB64),
  );
  return decoder.decode(pt);
}
