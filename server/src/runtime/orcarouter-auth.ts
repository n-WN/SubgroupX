import crypto from "node:crypto";
import { errorMessage } from "../foundation/errors.ts";
import { decryptKey, encryptKey } from "../identity/auth.ts";
import { keyDao, orcaCredentialDao } from "../persistence/index.ts";
import {
  ORCA_AUTH_EXCHANGE_PATH,
  ORCAROUTER_PROVIDER,
  looksLikeOrcaKey,
  orcaAuthBase,
} from "./orcarouter.ts";

/**
 * OrcaRouter credentials — one seam, two adapters.
 *
 * Both the pasted API key and the OAuth 2.0 + PKCE login end at exactly one place:
 * `persistOrcaKey` writes the ordinary OrcaRouter API key into the project's existing
 * encrypted provider-key store. Provider requests, model discovery and every AI entry
 * point read the key through `keyDao`, so nothing downstream knows which adapter ran.
 */

export type OrcaCredentialSource = "api_key" | "oauth_pkce";

export interface OrcaCredential {
  key: string;
  source: OrcaCredentialSource;
  generation: number;
  needsReauth: boolean;
}

export interface OrcaCredentialAdapter {
  readonly source: OrcaCredentialSource;
  /** Whether this adapter can produce a credential without user input right now. */
  available(userId: string): boolean;
  read(userId: string): OrcaCredential | null;
}

/** Reads whatever adapter produced the stored key; the transport never branches on it. */
export function readOrcaCredential(userId: string): OrcaCredential | null {
  const row = keyDao.get(userId, ORCAROUTER_PROVIDER);
  if (!row) return null;
  const state = orcaCredentialDao.get(userId);
  let key: string;
  try {
    key = decryptKey(row.enc_key);
  } catch {
    // A key encrypted under a rotated secret cannot be used; treat it as unreadable
    // rather than handing ciphertext to the transport.
    return null;
  }
  return {
    key,
    source: state?.source === "oauth_pkce" ? "oauth_pkce" : "api_key",
    generation: state?.generation ?? 1,
    needsReauth: state?.needs_reauth === 1,
  };
}

export function orcaCredentialState(userId: string): {
  configured: boolean;
  hint: string | null;
  source: OrcaCredentialSource | null;
  needsReauth: boolean;
  generation: number;
} {
  const row = keyDao.get(userId, ORCAROUTER_PROVIDER);
  const state = orcaCredentialDao.get(userId);
  return {
    configured: Boolean(row),
    hint: row?.hint ?? null,
    source: row ? (state?.source === "oauth_pkce" ? "oauth_pkce" : "api_key") : null,
    needsReauth: state?.needs_reauth === 1,
    generation: state?.generation ?? 0,
  };
}

/**
 * The single write path for both adapters. Bumping the generation invalidates any
 * in-flight request from an older credential, and clears `needsReauth` because the
 * new key has not been rejected yet.
 */
export function persistOrcaKey(
  userId: string,
  key: string,
  source: OrcaCredentialSource,
  scope: string | null,
): { hint: string; generation: number } {
  const normalized = key.trim();
  if (!looksLikeOrcaKey(normalized)) throw new Error("that does not look like an OrcaRouter API key (sk-orca-…)");
  const generation = orcaCredentialDao.rotate(userId, source, scope);
  keyDao.upsert({
    user_id: userId,
    provider: ORCAROUTER_PROVIDER,
    enc_key: encryptKey(normalized),
    hint: normalized.slice(-4),
    updated_at: Date.now(),
  });
  return { hint: normalized.slice(-4), generation };
}

/** Clear a credential only when the caller names the generation it holds. */
export function clearOrcaKey(userId: string): void {
  keyDao.delete(userId, ORCAROUTER_PROVIDER);
  orcaCredentialDao.clear(userId);
}

/**
 * A relay 401 means the durable key was revoked or is invalid. There is no refresh
 * grant, so mark exactly the rejected generation for reauthentication and leave the
 * stored secret in place until a new login succeeds.
 */
export function markOrcaNeedsReauth(userId: string, generation: number): void {
  orcaCredentialDao.markNeedsReauth(userId, generation);
}

export function orcaCredentialGeneration(userId: string): number {
  return orcaCredentialDao.get(userId)?.generation ?? 0;
}

// ---------------------------------------------------------------------------
// PKCE (Flow B — out-of-band code)
//
// The client is a hosted web app whose address differs per deployment and whose
// server cannot receive a browser redirect for every user, so the consent screen
// hands the user a code to paste back. S256 is mandatory in this flow.
// ---------------------------------------------------------------------------

const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 256;

export type OrcaLoginAttemptView = { attemptId: string; url: string; expiresAt: number };

type Attempt = {
  id: string;
  userId: string;
  verifier: string;
  state: string;
  generation: number;
  createdAt: number;
};

const attempts = new Map<string, Attempt>();

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

function pruneAttempts(now: number): void {
  for (const [id, attempt] of attempts) {
    if (now - attempt.createdAt > ATTEMPT_TTL_MS) attempts.delete(id);
  }
  while (attempts.size >= MAX_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (!oldest) break;
    attempts.delete(oldest);
  }
}

let fetchImpl: typeof fetch = fetch;
/** Test seam: the PKCE exchange is exercised against a local fake auth server. */
export function setOrcaFetchForTests(next: typeof fetch | null): void {
  fetchImpl = next ?? fetch;
}

export function startOrcaLogin(userId: string, appName = "oiia"): OrcaLoginAttemptView {
  const now = Date.now();
  pruneAttempts(now);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const attempt: Attempt = {
    id: "orca_" + crypto.randomBytes(12).toString("hex"),
    userId,
    verifier,
    state,
    generation: orcaCredentialGeneration(userId),
    createdAt: now,
  };
  attempts.set(attempt.id, attempt);
  const url = new URL("/auth", orcaAuthBase());
  url.searchParams.set("callback_url", "oob");
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("app_name", appName);
  url.searchParams.set("scope", "api");
  return { attemptId: attempt.id, url: url.toString(), expiresAt: now + ATTEMPT_TTL_MS };
}

export function cancelOrcaLogin(userId: string, attemptId: string): boolean {
  const attempt = attempts.get(attemptId);
  if (!attempt || attempt.userId !== userId) return false;
  attempts.delete(attemptId);
  return true;
}

export type OrcaLoginResult =
  | { ok: true; hint: string; scope: string; generation: number }
  | { ok: false; reason: "expired" | "state_mismatch" | "denied" | "rejected" | "network" | "scope"; message: string };

function safeMessage(prefix: string, status: number): string {
  // Never echo the response body: an exchange error can carry credential material.
  if (status === 400) return `${prefix}: the code challenge did not match (HTTP 400)`;
  if (status === 403) return `${prefix}: that code is unknown, expired or already used (HTTP 403)`;
  if (status === 429) return `${prefix}: too many authorization requests — wait a moment (HTTP 429)`;
  return `${prefix}: OrcaRouter rejected the exchange (HTTP ${status})`;
}

/**
 * Redeem a pasted authorization code. The verifier never leaves this process except
 * in the exchange body, and the resulting key is written through `persistOrcaKey`.
 */
export async function completeOrcaLogin(
  userId: string,
  attemptId: string,
  rawCode: string,
): Promise<OrcaLoginResult> {
  const attempt = attempts.get(attemptId);
  if (!attempt || attempt.userId !== userId) return { ok: false, reason: "expired", message: "this sign-in attempt expired — start again" };
  if (Date.now() - attempt.createdAt > ATTEMPT_TTL_MS) {
    attempts.delete(attemptId);
    return { ok: false, reason: "expired", message: "this sign-in attempt expired — start again" };
  }
  const parsed = new URLSearchParams(rawCode.trim().replace(/^[^?]*\?/, ""));
  const code = (parsed.get("code") ?? rawCode).trim().replace(/\s+/g, "");
  const returnedState = parsed.get("state");
  if (returnedState !== null) {
    const a = Buffer.from(returnedState);
    const b = Buffer.from(attempt.state);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "state_mismatch", message: "the authorization response did not belong to this attempt" };
    }
  }
  const err = parsed.get("error");
  if (err) {
    attempts.delete(attemptId);
    return { ok: false, reason: "denied", message: `authorization was not granted (${err.slice(0, 40)})` };
  }
  if (!code || code.length > 512) return { ok: false, reason: "rejected", message: "paste the code shown on the consent screen" };

  const endpoint = new URL(ORCA_AUTH_EXCHANGE_PATH, orcaAuthBase());
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: attempt.verifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, reason: "network", message: `could not reach OrcaRouter: ${errorMessage(e).slice(0, 120)}` };
  }
  if (!res.ok) {
    if (res.status === 403) attempts.delete(attemptId);
    return { ok: false, reason: res.status === 429 ? "network" : "rejected", message: safeMessage("sign-in failed", res.status) };
  }
  let payload: { key?: unknown; scope?: unknown };
  try {
    payload = (await res.json()) as { key?: unknown; scope?: unknown };
  } catch {
    return { ok: false, reason: "rejected", message: "sign-in failed: OrcaRouter returned an unreadable response" };
  }
  if (typeof payload.key !== "string" || !looksLikeOrcaKey(payload.key)) {
    return { ok: false, reason: "rejected", message: "sign-in failed: no usable key was returned" };
  }
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  if (scope && scope !== "api") {
    // Read the granted scope back: a narrower grant cannot serve inference.
    attempts.delete(attemptId);
    return { ok: false, reason: "scope", message: `OrcaRouter granted "${scope.slice(0, 24)}", which cannot call inference — ask a workspace admin for the api scope` };
  }
  attempts.delete(attemptId);
  const saved = persistOrcaKey(userId, payload.key, "oauth_pkce", scope || "api");
  return { ok: true, hint: saved.hint, scope: scope || "api", generation: saved.generation };
}

export function orcaPendingAttemptCount(): number {
  return attempts.size;
}
