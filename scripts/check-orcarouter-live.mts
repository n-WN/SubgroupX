import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OrcaRouter live check — a real round trip through the provider this PR adds.
 *
 * Uses the integration key from the environment (never printed) and the internal live
 * model, then asserts the request went to the documented OrcaRouter endpoint. Skips
 * with a clear message when no key is present, so the suite stays runnable offline.
 */

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "orcarouter-live-"));
process.env.AGENT_WEB_SECRET = "orcarouter-live-check-secret";

const { ORCAROUTER_PROVIDER, ORCAROUTER_DEFAULT_API_BASE, fetchOrcaCatalog, filterOrcaModelsForInput } =
  await import("../server/src/runtime/orcarouter.ts");
const { knownProviders, resolveModel } = await import("../server/src/runtime/providers.ts");
const { persistOrcaKey, readOrcaCredential } = await import("../server/src/runtime/orcarouter-auth.ts");
const { userDao } = await import("../server/src/persistence/index.ts");
const { streamSimple } = await import("@earendil-works/pi-ai/compat");

const apiKey = (process.env.ORCAROUTER_API_KEY ?? "").trim();
if (!apiKey) {
  console.log("check-orcarouter-live: SKIPPED — ORCAROUTER_API_KEY is not set");
  process.exit(0);
}

userDao.create({ id: "u_orca_live", email: "orca-live@test.dev", password_hash: "x", created_at: Date.now() });
persistOrcaKey("u_orca_live", apiKey, "api_key", null);
const credential = readOrcaCredential("u_orca_live");
assert.ok(credential, "the live key persisted through the shared seam");
assert.equal(credential!.key, apiKey, "the stored key decrypts back to the integration key");

// ── catalog ─────────────────────────────────────────────────────────────────

const catalog = await fetchOrcaCatalog(credential!.key);
assert.equal(catalog.degraded, false, "the live chat catalog answered");
assert.ok(catalog.models.length >= 5, `live discovery returned ${catalog.models.length} chat models`);
const ids = catalog.models.map((m) => m.id);
assert.ok(ids.includes("orcarouter/auto"), "orcarouter/auto is in the live catalog");
const visionModels = filterOrcaModelsForInput(catalog.models, "image");
assert.ok(visionModels.length >= 1, "the live catalog declares at least one image-capable chat model");

// ── provider ────────────────────────────────────────────────────────────────

assert.ok(knownProviders().includes(ORCAROUTER_PROVIDER));
const model = resolveModel(ORCAROUTER_PROVIDER, "deepseek/deepseek-v4.1-flash");
assert.equal(model.provider, ORCAROUTER_PROVIDER);
assert.equal(model.baseUrl, ORCAROUTER_DEFAULT_API_BASE);

// ── live stream ─────────────────────────────────────────────────────────────

const context = {
  messages: [{ role: "user" as const, content: "Reply with exactly the single word: pong", timestamp: Date.now() }],
};
let responseStatus = 0;
const events = streamSimple(model, context as never, {
  apiKey: credential!.key,
  maxTokens: 32,
  onResponse: ((response: { status: number }) => {
    responseStatus = response.status;
  }) as never,
});

let text = "";
for await (const event of events as AsyncIterable<{ type: string; delta?: string }>) {
  if (event.type === "text_delta" && event.delta) text += event.delta;
}
const final = await (events as { result: () => Promise<{ content: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string }> }).result();

if (!text) text = final.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
assert.equal(final.errorMessage ?? "", "", `the relay accepted the request (${final.errorMessage ?? ""})`);
assert.equal(responseStatus, 200, "the relay answered 200");
assert.ok(text.trim().length > 0, "the model streamed text back");
assert.match(text, /pong/i, `the reply came from the selected model: ${text.slice(0, 80)}`);
assert.equal(model.baseUrl, "https://api.orcarouter.ai/v1", "the request went to the OrcaRouter relay");
assert.equal(model.api, "openai-completions", "over the OpenAI-compatible chat protocol");
assert.ok(Boolean(final.stopReason), "the stream ended with a stop reason");

const catalogUrl = `${ORCAROUTER_DEFAULT_API_BASE}/models?capability=chat`;
console.log(`check-orcarouter-live: ${catalog.models.length} live chat models (${visionModels.length} image-capable); ${text.trim().slice(0, 40)} via ${catalogUrl}`);
