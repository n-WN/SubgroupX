import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OrcaRouter PKCE adapter — the OAuth 2.0 + PKCE flow (out-of-band code), its
 * terminal failure semantics and the credential handoff into the shared seam.
 *
 * No network: the exchange is served by a local stand-in that asserts the exact
 * request shape the spec requires, so a wrong endpoint, verifier or grant fails here.
 */

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "orcarouter-auth-"));
process.env.AGENT_WEB_SECRET = "orcarouter-auth-check-secret";

const { ORCA_AUTH_AUTHORIZE_PATH, ORCA_AUTH_EXCHANGE_PATH, looksLikeOrcaKey } =
  await import("../server/src/runtime/orcarouter.ts");
const auth = await import("../server/src/runtime/orcarouter-auth.ts");
const { decryptKey } = await import("../server/src/identity/auth.ts");
const { keyDao, userDao } = await import("../server/src/persistence/index.ts");

const USER = "u_orca_pkce";
const OTHER = "u_orca_other";
userDao.create({ id: USER, email: "orca-pkce@test.dev", password_hash: "x", created_at: Date.now() });
userDao.create({ id: OTHER, email: "orca-pkce-other@test.dev", password_hash: "x", created_at: Date.now() });

type Exchange = {
  url: string;
  method: string;
  contentType: string;
  body: { code?: string; code_verifier?: string; code_challenge_method?: string };
};

let seen: Exchange[] = [];

function fakeAuth(handler: (exchange: Exchange) => { status: number; body?: unknown; raw?: string }) {
  seen = [];
  auth.setOrcaFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const exchange: Exchange = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      contentType: String((init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? ""),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    seen.push(exchange);
    const reply = handler(exchange);
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return (): Exchange[] => seen;
}

const ISSUED_KEY = "sk-orca-pkce-issued-key-4242";
const acceptEverything = () => ({ status: 200, body: { key: ISSUED_KEY, scope: "api" } });

// ── pkce: the authorization URL ──────────────────────────────────────────────

const start = auth.startOrcaLogin(USER, "oiia");
assert.match(start.attemptId, /^orca_/, "each attempt has a server-side identifier");
assert.ok(start.expiresAt > Date.now(), "the attempt expires in the future");

const authUrl = new URL(start.url);
assert.equal(authUrl.origin, "https://www.orcarouter.ai", "consent lives on the auth origin, not the API origin");
assert.equal(authUrl.pathname, ORCA_AUTH_AUTHORIZE_PATH);
assert.equal(authUrl.pathname, "/auth");
assert.equal(authUrl.searchParams.get("callback_url"), "oob", "the out-of-band flow asks for a paste-back code");
assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256", "S256 is mandatory — never plain");
assert.equal(authUrl.searchParams.get("scope"), "api", "the api scope is required for inference");
assert.equal(authUrl.searchParams.get("app_name"), "oiia");
const challenge = authUrl.searchParams.get("code_challenge") ?? "";
assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, "the challenge is an unpadded base64url SHA-256 digest");
const state = authUrl.searchParams.get("state") ?? "";
assert.match(state, /^[A-Za-z0-9_-]{22}$/, "the state is 16 random bytes, base64url");

// A second attempt gets fresh material: the verifier/state are never reused.
const second = auth.startOrcaLogin(USER, "oiia");
const secondUrl = new URL(second.url);
assert.notEqual(second.attemptId, start.attemptId);
assert.notEqual(secondUrl.searchParams.get("code_challenge"), challenge, "a new login mints a new verifier");
assert.notEqual(secondUrl.searchParams.get("state"), state, "a new login mints a new state");
auth.cancelOrcaLogin(USER, second.attemptId);

// ── pkce: the exchange ──────────────────────────────────────────────────────

const exchanges = fakeAuth(acceptEverything);
const success = await auth.completeOrcaLogin(USER, start.attemptId, "the-pasted-code");
assert.equal(success.ok, true, `the redeem succeeds: ${JSON.stringify(success)}`);
assert.equal(seen.length, 1, "exactly one exchange per completion");

const exchange = seen[0];
assert.equal(exchange.method, "POST");
assert.equal(exchange.contentType, "application/json");
const exchangeUrl = new URL(exchange.url);
assert.equal(exchangeUrl.origin, "https://www.orcarouter.ai", "the exchange stays on the auth origin");
assert.equal(exchangeUrl.pathname, ORCA_AUTH_EXCHANGE_PATH);
assert.equal(exchangeUrl.pathname, "/api/v1/auth/keys", "never the relay's /v1/auth/keys");
assert.equal(exchange.body.code, "the-pasted-code");
assert.equal(exchange.body.code_challenge_method, "S256");
const verifier = exchange.body.code_verifier ?? "";
assert.match(verifier, /^[A-Za-z0-9_-]{43}$/, "the verifier is 32 random bytes, base64url");
assert.equal(
  crypto.createHash("sha256").update(verifier).digest("base64url"),
  challenge,
  "the sent verifier hashes to the challenge that was authorized",
);

// The issued key lands in the shared encrypted store, tagged with its adapter.
assert.equal(success.ok && success.hint, "4242");
assert.equal(success.ok && success.scope, "api");
assert.equal(auth.orcaCredentialState(USER).source, "oauth_pkce", "the seam records the PKCE adapter");
assert.equal(auth.orcaCredentialState(USER).configured, true);
const stored = keyDao.get(USER, "orcarouter");
assert.ok(stored, "the PKCE result is stored exactly where a pasted key would be");
assert.ok(!stored!.enc_key.includes(ISSUED_KEY), "the issued key is encrypted at rest");
assert.equal(decryptKey(stored!.enc_key), ISSUED_KEY);
assert.equal(auth.readOrcaCredential(USER)!.key, ISSUED_KEY, "the transport reads the PKCE key through the same seam");
assert.ok(looksLikeOrcaKey(ISSUED_KEY));

// An attempt is single-use.
const replay = await auth.completeOrcaLogin(USER, start.attemptId, "the-pasted-code");
assert.equal(replay.ok, false);
assert.equal(replay.ok === false && replay.reason, "expired", "a redeemed attempt cannot be replayed");
assert.equal(seen.length, 1, "a replay does not reach the auth server");

// ── pkce: terminal failure semantics ───────────────────────────────────────

const generationBefore = auth.orcaCredentialGeneration(USER);

// Wrong state: the response does not belong to this attempt.
fakeAuth(acceptEverything);
const stateAttempt = auth.startOrcaLogin(USER, "oiia");
const badState = await auth.completeOrcaLogin(USER, stateAttempt.attemptId, "code-123&state=not-the-state");
assert.equal(badState.ok, false);
assert.equal(badState.ok === false && badState.reason, "state_mismatch");
assert.equal(seen.length, 0, "a mismatched state is rejected before any network call");

// A full redirect URL is accepted, and its own state is compared.
const goodState = new URL(stateAttempt.url).searchParams.get("state") ?? "";
const pastedUrl = await auth.completeOrcaLogin(USER, stateAttempt.attemptId, `https://www.orcarouter.ai/auth?code=code-456&state=${goodState}`);
assert.equal(pastedUrl.ok, true, "a pasted redirect URL is parsed, not treated as a literal code");
assert.equal(seen[0].body.code, "code-456", "the code is extracted from the URL");

// Denied consent.
fakeAuth(acceptEverything);
const deniedAttempt = auth.startOrcaLogin(USER, "oiia");
const denied = await auth.completeOrcaLogin(USER, deniedAttempt.attemptId, "error=access_denied");
assert.equal(denied.ok, false);
assert.equal(denied.ok === false && denied.reason, "denied");

// HTTP failures are reported without echoing the response body.
fakeAuth(() => ({ status: 403, body: { error: "unknown code", secret: "should-not-surface" } }));
const rejectedAttempt = auth.startOrcaLogin(USER, "oiia");
const rejected = await auth.completeOrcaLogin(USER, rejectedAttempt.attemptId, "stale-code");
assert.equal(rejected.ok, false);
assert.equal(rejected.ok === false && rejected.reason, "rejected");
assert.match(rejected.ok === false ? rejected.message : "", /HTTP 403/);
assert.ok(!(rejected.ok === false ? rejected.message : "").includes("should-not-surface"), "the exchange body is never echoed");

fakeAuth(() => ({ status: 400, body: {} }));
const mismatchAttempt = auth.startOrcaLogin(USER, "oiia");
const challengeMismatch = await auth.completeOrcaLogin(USER, mismatchAttempt.attemptId, "code-789");
assert.equal(challengeMismatch.ok === false && challengeMismatch.reason, "rejected");
assert.match(challengeMismatch.ok === false ? challengeMismatch.message : "", /code challenge/i);

// Unreadable or keyless success bodies are rejections, not silent successes.
fakeAuth(() => ({ status: 200, raw: "not json" }));
const unreadableAttempt = auth.startOrcaLogin(USER, "oiia");
const unreadable = await auth.completeOrcaLogin(USER, unreadableAttempt.attemptId, "code-abc");
assert.equal(unreadable.ok === false && unreadable.reason, "rejected");

fakeAuth(() => ({ status: 200, body: { scope: "api" } }));
const keylessAttempt = auth.startOrcaLogin(USER, "oiia");
const keyless = await auth.completeOrcaLogin(USER, keylessAttempt.attemptId, "code-abc");
assert.equal(keyless.ok === false && keyless.reason, "rejected", "a response without an sk-orca- key is not a credential");

// A narrower granted scope cannot serve inference.
fakeAuth(() => ({ status: 200, body: { key: "sk-orca-readonly-scope-key-9999", scope: "read" } }));
const scopeAttempt = auth.startOrcaLogin(USER, "oiia");
const narrow = await auth.completeOrcaLogin(USER, scopeAttempt.attemptId, "code-abc");
assert.equal(narrow.ok === false && narrow.reason, "scope");
assert.match(narrow.ok === false ? narrow.message : "", /cannot call inference/);

// A transport failure is a network error, and the stored key survives.
fakeAuth(() => { throw new Error("connect ECONNREFUSED"); });
const networkAttempt = auth.startOrcaLogin(USER, "oiia");
const network = await auth.completeOrcaLogin(USER, networkAttempt.attemptId, "code-abc");
assert.equal(network.ok === false && network.reason, "network");
assert.ok(!(network.ok === false ? network.message : "").includes(ISSUED_KEY));

// Every failure above left the previously issued credential intact.
assert.equal(auth.orcaCredentialGeneration(USER), generationBefore + 1, "only the successful exchanges rotated the credential");
assert.equal(auth.readOrcaCredential(USER)!.key, ISSUED_KEY, "a failed re-login never deletes the working key");
assert.equal(auth.orcaCredentialState(USER).needsReauth, false);

// Attempts are owner-scoped: another user cannot redeem this attempt.
fakeAuth(acceptEverything);
const ownedAttempt = auth.startOrcaLogin(USER, "oiia");
const stolen = await auth.completeOrcaLogin(OTHER, ownedAttempt.attemptId, "code-xyz");
assert.equal(stolen.ok === false && stolen.reason, "expired", "an attempt is invisible to another account");
assert.equal(seen.length, 0);
assert.equal(auth.cancelOrcaLogin(OTHER, ownedAttempt.attemptId), false);
assert.equal(auth.cancelOrcaLogin(USER, ownedAttempt.attemptId), true);

// Cancelling an unknown attempt is a no-op, not a throw.
assert.equal(auth.cancelOrcaLogin(USER, "orca_does_not_exist"), false);
assert.equal(auth.orcaPendingAttemptCount() >= 0, true);

auth.setOrcaFetchForTests(null);

console.log("check-orcarouter-auth: PKCE S256 exchange, terminal failures and key handoff hold");
