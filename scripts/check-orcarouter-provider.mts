import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OrcaRouter provider — unit coverage for the provider entry, the API-key adapter,
 * the catalog parser and the multimodal capability gate.
 *
 * The PKCE exchange and its failure semantics live in check-orcarouter-auth.mts; the
 * real relay call lives in check-orcarouter-live.mts.
 */

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "orcarouter-provider-"));
process.env.AGENT_WEB_SECRET = "orcarouter-provider-check-secret";

const {
  ORCAROUTER_PROVIDER,
  ORCAROUTER_LABEL,
  ORCAROUTER_DEFAULT_API_BASE,
  ORCAROUTER_KEY_PREFIX,
  ORCA_MAX_CATALOG_ITEMS,
  ORCA_VERIFIED_SEED,
  fetchOrcaCatalog,
  filterOrcaModelsForInput,
  looksLikeOrcaKey,
  normalizeCatalogRecord,
  orcaApiBase,
  orcaAuthBase,
  orcaCatalogSnapshot,
  parseCatalogPayload,
  resetOrcaCatalogCache,
  toOrcaModel,
} = await import("../server/src/runtime/orcarouter.ts");
const {
  clearOrcaKey,
  markOrcaNeedsReauth,
  orcaCredentialGeneration,
  orcaCredentialState,
  persistOrcaKey,
  readOrcaCredential,
} = await import("../server/src/runtime/orcarouter-auth.ts");
const { decryptKey, encryptKey } = await import("../server/src/identity/auth.ts");
const { keyDao, userDao } = await import("../server/src/persistence/index.ts");
const { knownProviders, listModelsForProviders, resolveModel } = await import("../server/src/runtime/providers.ts");
const { modelsForDraft, modelStillCompatible } = await import("../web/src/platform/model-capabilities.ts");

const USER = "u_orca_provider";
userDao.create({ id: USER, email: "orca-provider@test.dev", password_hash: "x", created_at: Date.now() });

const API_KEY = "sk-orca-provider-check-key-0001";

// ── provider ────────────────────────────────────────────────────────────────

assert.ok(knownProviders().includes(ORCAROUTER_PROVIDER), "orcarouter is a first-class named provider");
assert.equal(ORCAROUTER_LABEL, "OrcaRouter Cyber Inference");
assert.ok(ORCAROUTER_PROVIDER.includes("orcarouter"));

const rows = listModelsForProviders([ORCAROUTER_PROVIDER]).filter((m) => m.provider === ORCAROUTER_PROVIDER);
assert.ok(rows.length > 0, "the provider advertises a model list before any live call");
assert.ok(rows.some((m) => m.id === "orcarouter/auto"), "the default router model is offered");
assert.ok(rows.some((m) => m.id === "orca/orcacyber-ultra-1.0"), "OrcaCyber Ultra is offered");
assert.ok(rows.some((m) => m.id === "orca/orcacyber-zero-1.5"), "OrcaCyber Zero is offered");
assert.ok(rows.some((m) => m.id === "orcarouter/fusion"), "the fusion fallback is offered");
assert.ok(rows.every((m) => m.provider === ORCAROUTER_PROVIDER), "no foreign provider rows leak into the OrcaRouter catalog");

const model = resolveModel(ORCAROUTER_PROVIDER, "orcarouter/auto");
assert.equal(model.api, "openai-completions", "OrcaRouter speaks the OpenAI-compatible chat protocol");
assert.equal(model.baseUrl, ORCAROUTER_DEFAULT_API_BASE, "inference goes to the documented api base");
assert.equal(model.baseUrl, "https://api.orcarouter.ai/v1");
assert.match(String((model.headers as Record<string, string> | undefined)?.["User-Agent"] ?? ""), /^oiia\//);
assert.throws(() => resolveModel(ORCAROUTER_PROVIDER, "not-a-real-model"), /unknown OrcaRouter model/);

// The auth origin is configured separately and is never derived from the API base.
assert.equal(orcaApiBase(), "https://api.orcarouter.ai/v1");
assert.equal(orcaAuthBase(), "https://www.orcarouter.ai");
process.env.ORCA_API_BASE_URL = "http://localhost:8081/v1";
assert.equal(orcaApiBase(), "http://localhost:8081/v1", "an explicit loopback API base is honoured for self-hosting");
assert.equal(orcaAuthBase(), "https://www.orcarouter.ai", "overriding the API base does not move the auth origin");
process.env.ORCA_API_BASE_URL = "http://evil.example/v1";
assert.equal(orcaApiBase(), "https://api.orcarouter.ai/v1", "plaintext remote origins are refused");
delete process.env.ORCA_API_BASE_URL;

// ── api_key ─────────────────────────────────────────────────────────────────

assert.ok(looksLikeOrcaKey(API_KEY), "a sk-orca- key is recognised");
assert.ok(!looksLikeOrcaKey("sk-openai-123"), "another vendor's key is rejected");
assert.ok(!looksLikeOrcaKey(`${ORCAROUTER_KEY_PREFIX}short`), "an implausibly short key is rejected");

const saved = persistOrcaKey(USER, `  ${API_KEY}  `, "api_key", null);
assert.equal(saved.hint, "0001", "the display hint is the last four characters");
assert.equal(saved.generation, 1, "the first credential starts at generation 1");

const stored = keyDao.get(USER, ORCAROUTER_PROVIDER);
assert.ok(stored, "the key is stored under the provider's own slot");
assert.ok(!stored!.enc_key.includes(API_KEY), "the key is not stored in plaintext");
assert.equal(decryptKey(stored!.enc_key), API_KEY, "the existing AES-256-GCM store round-trips the key");
assert.notEqual(encryptKey(API_KEY), encryptKey(API_KEY), "each encryption uses a fresh IV");

const credential = readOrcaCredential(USER);
assert.ok(credential, "both adapters read through one credential seam");
assert.equal(credential!.key, API_KEY);
assert.equal(credential!.source, "api_key");
assert.equal(credential!.needsReauth, false);

let state = orcaCredentialState(USER);
assert.equal(state.configured, true);
assert.equal(state.source, "api_key");
assert.equal(state.hint, "0001");

assert.throws(() => persistOrcaKey(USER, "not-a-key-at-all-xxxxxxxx", "api_key", null), /sk-orca/);

const rotated = persistOrcaKey(USER, `${API_KEY}x`, "api_key", null);
assert.equal(rotated.generation, 2, "saving again bumps the generation, invalidating in-flight requests");
assert.equal(orcaCredentialGeneration(USER), 2);

// A rejected generation is terminal for exactly that credential, not the new one.
markOrcaNeedsReauth(USER, 1);
assert.equal(orcaCredentialState(USER).needsReauth, false, "a stale generation cannot poison the live credential");
assert.equal(readOrcaCredential(USER)!.needsReauth, false);
markOrcaNeedsReauth(USER, rotated.generation);
assert.equal(orcaCredentialState(USER).needsReauth, true, "the rejected generation asks for a reconnect");
assert.equal(keyDao.get(USER, ORCAROUTER_PROVIDER)!.hint, "001x", "the secret is kept until a new login succeeds");

// Reauthorizing clears the flag and moves to a new generation.
const reauthorized = persistOrcaKey(USER, API_KEY, "oauth_pkce", "api");
assert.equal(reauthorized.generation, 3);
state = orcaCredentialState(USER);
assert.equal(state.needsReauth, false);
assert.equal(state.source, "oauth_pkce", "the seam records which adapter produced the key");

clearOrcaKey(USER);
assert.equal(orcaCredentialState(USER).configured, false);
assert.equal(readOrcaCredential(USER), null);
assert.equal(orcaCredentialState(USER).generation, 0);

// ── catalog ─────────────────────────────────────────────────────────────────

const live = {
  data: [
    {
      id: "orcarouter/auto",
      name: "OrcaRouter Auto",
      context_length: 128_000,
      max_completion_tokens: 32_768,
      architecture: { input_modalities: ["text", "image"] },
      supported_endpoint_types: ["openai"],
    },
    {
      id: "embeddings/only",
      name: "Embeddings Only",
      supported_endpoint_types: ["embeddings"],
    },
    { id: "bad id with spaces", supported_endpoint_types: ["openai"] },
    { id: "no-endpoints" },
    {
      id: "text/plain",
      context_length: 99_999_999,
      supported_endpoint_types: ["anthropic"],
    },
  ],
};
const parsed = parseCatalogPayload(live);
assert.deepEqual(parsed.map((m) => m.id), ["orcarouter/auto", "text/plain"], "only usable chat endpoints survive");
assert.deepEqual(parsed[0].inputModalities, ["text", "image"], "declared modalities are preserved");
assert.deepEqual(parsed[1].inputModalities, ["text"], "an absent architecture field means text only");
assert.equal(parsed[1].contextWindow, 2_000_000, "an absurd context window is capped");

assert.deepEqual(parseCatalogPayload({ data: "nope" }), [], "a malformed payload yields no models rather than throwing");
assert.equal(normalizeCatalogRecord(null), null);
assert.equal(normalizeCatalogRecord({ id: "x", supported_endpoint_types: ["image-generation"] }), null, "image-generation endpoints are not chat models");
assert.equal(
  normalizeCatalogRecord({ id: "y", supported_endpoint_types: ["embeddings", "openai"] })!.id,
  "y",
  "a record that also offers a chat endpoint is kept",
);

const oversized = { data: Array.from({ length: ORCA_MAX_CATALOG_ITEMS + 50 }, (_, i) => ({ id: `m/${i}`, supported_endpoint_types: ["openai"] })) };
assert.equal(parseCatalogPayload(oversized).length, ORCA_MAX_CATALOG_ITEMS, "the parse is bounded to a fixed item count");

// A live response replaces the seed wholesale; it is never merged with it.
const realFetch = globalThis.fetch;
const liveCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  liveCalls.push(String(input));
  return new Response(JSON.stringify(live), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
resetOrcaCatalogCache();
const fetched = await fetchOrcaCatalog(API_KEY);
globalThis.fetch = realFetch;
assert.equal(fetched.degraded, false, "a successful discovery is not degraded");
assert.deepEqual(fetched.models.map((m) => m.id), ["orcarouter/auto", "text/plain"], "seed rows are not merged into live results");
assert.ok(liveCalls[0].includes("/models?capability=chat"), "discovery hits the authoritative chat catalog");
assert.equal(orcaCatalogSnapshot().degraded, false, "the synchronous model listing sees the live catalog");
assert.ok(!listModelsForProviders([ORCAROUTER_PROVIDER]).some((m) => m.id === "orcarouter/fusion"), "seed-only rows disappear once live data is authoritative");

// Discovery failure degrades to the verified seed instead of hiding the provider.
globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
resetOrcaCatalogCache();
const degraded = await fetchOrcaCatalog(API_KEY);
globalThis.fetch = realFetch;
assert.equal(degraded.degraded, true, "an unreachable catalog is flagged degraded");
assert.deepEqual(degraded.models.map((m) => m.id), ORCA_VERIFIED_SEED.map((m) => m.id), "the verified seed is the documented fallback");
assert.ok(degraded.models.some((m) => m.id === "orcarouter/auto"));

// The catalog is public: a rejected key falls back to an anonymous read, not to "no models".
const statuses: number[] = [];
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const authorized = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
  statuses.push(authorized ? 401 : 200);
  return authorized
    ? new Response("{}", { status: 401 })
    : new Response(JSON.stringify(live), { status: 200 });
}) as typeof fetch;
resetOrcaCatalogCache();
const anonymous = await fetchOrcaCatalog("sk-orca-revoked-key-000000");
globalThis.fetch = realFetch;
assert.deepEqual(statuses, [401, 200], "a revoked key retries anonymously once");
assert.equal(anonymous.degraded, false);
assert.ok(anonymous.models.length > 0);

// ── capabilities ────────────────────────────────────────────────────────────

const catalog = [
  { id: "text-only", name: "Text Only", contextWindow: 1000, maxTokens: 100, inputModalities: ["text" as const], endpointTypes: ["openai"], reasoning: false },
  { id: "vision", name: "Vision", contextWindow: 1000, maxTokens: 100, inputModalities: ["text" as const, "image" as const], endpointTypes: ["openai"], reasoning: false },
];
assert.deepEqual(filterOrcaModelsForInput(catalog, "text").map((m) => m.id), ["text-only", "vision"]);
assert.deepEqual(filterOrcaModelsForInput(catalog, "image").map((m) => m.id), ["vision"], "image entry points only offer image-capable models");

// Back to the verified seed for the capability assertions: the dropdown's contents
// must be driven by whatever the catalog actually served.
resetOrcaCatalogCache();
const optionRows = listModelsForProviders([ORCAROUTER_PROVIDER]).filter((m) => m.provider === ORCAROUTER_PROVIDER);
const visionRow = optionRows.find((m) => m.id === "deepseek/deepseek-v4.1-flash");
assert.ok(visionRow && visionRow.inputModalities?.includes("image"), "declared vision models carry their modalities to the client");
const textRow = optionRows.find((m) => m.id === "orcarouter/auto");
assert.ok(textRow && !textRow.inputModalities?.includes("image"));

assert.deepEqual(modelsForDraft(optionRows, []), optionRows, "an empty draft keeps every model");
const imageDraft = [{ type: "image/png" }];
const imageOptions = modelsForDraft(optionRows, imageDraft);
assert.ok(imageOptions.length > 0 && imageOptions.length < optionRows.length);
assert.ok(imageOptions.every((m) => m.inputModalities?.includes("image")), "an image draft fails closed on undeclared models");
assert.ok(!imageOptions.some((m) => m.id === "orcarouter/auto"), "text-only models are removed for an image draft");
assert.equal(modelsForDraft(optionRows, [{ type: "audio/mpeg" }]).length, 0, "an unsupported modality removes every model");
assert.equal(modelStillCompatible(optionRows.find((m) => m.id === "orcarouter/auto"), imageDraft), false, "a stale text-only selection is detected");
assert.equal(modelStillCompatible(optionRows.find((m) => m.id === "deepseek/deepseek-v4.1-flash"), imageDraft), true);

const resolvedVision = toOrcaModel(catalog[1]);
assert.deepEqual(resolvedVision.input, ["text", "image"], "the transport model carries pi's input capabilities");

// ── regression ──────────────────────────────────────────────────────────────

assert.ok(knownProviders().includes("kimi-coding"), "the existing provider registry is untouched");
assert.ok(knownProviders().includes("openrouter"));
const kimi = listModelsForProviders(["kimi-coding"]).filter((m) => m.provider === "kimi-coding");
assert.ok(kimi.length >= 2, "existing providers still list their own catalogs");
assert.ok(!kimi.some((m) => m.id.startsWith("orcarouter/")), "OrcaRouter rows do not leak into other providers");
assert.ok(!resolveModel("kimi-coding", "no-such-model"), "an unknown model still resolves empty elsewhere (pi's own semantics)");

console.log(`check-orcarouter-provider: provider, API-key seam, catalog bounds and capability gate hold (${rows.length} offered models)`);
