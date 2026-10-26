import crypto from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelInfo } from "../../../shared/src/protocol.ts";

/**
 * OrcaRouter Cyber Inference — a named, first-class provider for security teams.
 *
 * Inference and model discovery live on api.orcarouter.ai; account login lives on
 * www.orcarouter.ai. The two origins are configured independently so a self-hosted
 * deployment can point them at its own host, and neither is ever derived from the other.
 */

export const ORCAROUTER_PROVIDER = "orcarouter";
export const ORCAROUTER_LABEL = "OrcaRouter Cyber Inference";
export const ORCAROUTER_DEFAULT_API_BASE = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_DEFAULT_AUTH_BASE = "https://www.orcarouter.ai";
export const ORCAROUTER_KEY_PREFIX = "sk-orca-";
/** Auth endpoints live on the auth origin under /api/v1; the relay's /v1/auth/keys is a 404. */
export const ORCA_AUTH_EXCHANGE_PATH = "/api/v1/auth/keys";
export const ORCA_AUTH_AUTHORIZE_PATH = "/auth";
export const ORCAROUTER_DASHBOARD_URL = "https://www.orcarouter.ai/console";
export const ORCAROUTER_PROVIDER_URL = "https://www.orcarouter.ai/cyber";
export const ORCAROUTER_CYBER_CATALOG_URL = "https://www.orcarouter.ai/models?tier=cyber";

function httpsOrLoopback(raw: string, fallback: string): string {
  const value = raw.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fallback;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return fallback;
  return url.toString().replace(/\/+$/, "");
}

/** Shared self-hosted base, then explicit API/auth overrides; explicit values win. */
export function orcaApiBase(): string {
  const shared = process.env.ORCA_BASE_URL ?? "";
  const fallback = shared ? httpsOrLoopback(shared, ORCAROUTER_DEFAULT_API_BASE) : ORCAROUTER_DEFAULT_API_BASE;
  return httpsOrLoopback(process.env.ORCA_API_BASE_URL ?? "", fallback);
}

export function orcaAuthBase(): string {
  const shared = process.env.ORCA_BASE_URL ?? "";
  const fallback = shared ? httpsOrLoopback(shared, ORCAROUTER_DEFAULT_AUTH_BASE) : ORCAROUTER_DEFAULT_AUTH_BASE;
  return httpsOrLoopback(process.env.ORCA_AUTH_BASE_URL ?? "", fallback);
}

/** Model rows advertised by the catalog, reduced to the fields this app can trust. */
export type OrcaCatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities: Array<"text" | "image" | "audio" | "video">;
  endpointTypes: string[];
  reasoning: boolean;
};

const TEXT_ENDPOINT_TYPES = new Set(["openai", "openai-response", "anthropic", "gemini"]);
const NON_TEXT_ENDPOINT_TYPES = new Set([
  "image-generation",
  "openai-video",
  "jina-rerank",
  "embeddings",
  "rerank",
  "audio",
]);

export const ORCA_MAX_CATALOG_BYTES = 512 * 1024;
export const ORCA_MAX_CATALOG_ITEMS = 200;
export const ORCA_CATALOG_TIMEOUT_MS = 8_000;

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function modalitiesOf(raw: unknown): Array<"text" | "image" | "audio" | "video"> {
  const architecture = raw as { input_modalities?: unknown } | null;
  const list = Array.isArray(architecture?.input_modalities) ? architecture!.input_modalities : [];
  const out: Array<"text" | "image" | "audio" | "video"> = [];
  for (const item of list) {
    if (item === "image" || item === "audio" || item === "video") out.push(item);
  }
  // Every chat model accepts text; a catalog that omits the field is text-only rather
  // than "everything", so multimodal selectors fail closed.
  return ["text", ...out];
}

function endpointTypesOf(raw: unknown): string[] {
  const row = raw as { supported_endpoint_types?: unknown } | null;
  const list = Array.isArray(row?.supported_endpoint_types) ? row!.supported_endpoint_types : [];
  return list.filter((item): item is string => typeof item === "string").slice(0, 12);
}

/**
 * Reduce one catalog record to a model we can actually send to. Records without a
 * text chat endpoint are dropped: they cannot serve this app's only AI entry point.
 */
export function normalizeCatalogRecord(raw: unknown): OrcaCatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || id.length > 128 || !/^[A-Za-z0-9._~:/+-]+$/.test(id)) return null;
  const endpointTypes = endpointTypesOf(row);
  if (endpointTypes.length === 0 || !endpointTypes.some((t) => TEXT_ENDPOINT_TYPES.has(t))) return null;
  if (endpointTypes.every((t) => NON_TEXT_ENDPOINT_TYPES.has(t))) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 120) : id;
  return {
    id,
    name,
    contextWindow: boundedInt(row.context_length, 128_000, 2_000_000),
    maxTokens: boundedInt(row.max_completion_tokens, 32_768, 400_000),
    inputModalities: modalitiesOf(row.architecture),
    endpointTypes,
    // The live catalog carries no reasoning flag. Do not infer one from the model
    // name; a model is advertised as reasoning-capable only in the seed below.
    reasoning: false,
  };
}

/** Parse a catalog payload; invalid or oversized shapes yield no models, never a throw. */
export function parseCatalogPayload(payload: unknown): OrcaCatalogModel[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: OrcaCatalogModel[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, ORCA_MAX_CATALOG_ITEMS)) {
    const model = normalizeCatalogRecord(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Verified cold-start catalog. Each entry was observed on the live chat catalog and
 * keeps its advertised context window and input modalities. `reasoning` is recorded
 * only where this app has verified an effort ladder.
 */
export const ORCA_VERIFIED_SEED: OrcaCatalogModel[] = [
  { id: "orcarouter/auto", name: "OrcaRouter Auto", contextWindow: 128_000, maxTokens: 32_768, inputModalities: ["text"], endpointTypes: ["openai"], reasoning: false },
  { id: "orca/orcacyber-ultra-1.0", name: "OrcaCyber Ultra", contextWindow: 1_048_576, maxTokens: 131_072, inputModalities: ["text"], endpointTypes: ["openai"], reasoning: false },
  { id: "orca/orcacyber-zero-1.5", name: "OrcaCyber Zero", contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: ["text"], endpointTypes: ["openai"], reasoning: false },
  { id: "orcarouter/fusion", name: "OrcaRouter Fusion", contextWindow: 1_000_000, maxTokens: 32_768, inputModalities: ["text"], endpointTypes: ["openai"], reasoning: false },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_048_576, maxTokens: 384_000, inputModalities: ["text", "image"], endpointTypes: ["openai"], reasoning: false },
  { id: "openai/gpt-5.5", name: "GPT-5.5", contextWindow: 400_000, maxTokens: 128_000, inputModalities: ["text", "image"], endpointTypes: ["openai"], reasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh"] } as OrcaCatalogModel & { thinkingLevels: string[] },
  { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", contextWindow: 200_000, maxTokens: 64_000, inputModalities: ["text", "image"], endpointTypes: ["openai"], reasoning: true },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", contextWindow: 1_000_000, maxTokens: 65_536, inputModalities: ["text", "image"], endpointTypes: ["openai"], reasoning: true },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_048_576, maxTokens: 384_000, inputModalities: ["text"], endpointTypes: ["openai"], reasoning: true },
];

function seedThinkingLevels(id: string): string[] | undefined {
  const seed = ORCA_VERIFIED_SEED.find((m) => m.id === id) as (OrcaCatalogModel & { thinkingLevels?: string[] }) | undefined;
  return seed?.thinkingLevels;
}

export function toOrcaModel(row: OrcaCatalogModel): Model<string> & { thinkingLevelMap?: Record<string, string> } {
  const thinkingLevels = seedThinkingLevels(row.id);
  return {
    id: row.id,
    name: row.name,
    api: "openai-completions",
    provider: ORCAROUTER_PROVIDER,
    baseUrl: orcaApiBase(),
    reasoning: row.reasoning,
    input: row.inputModalities.filter((m) => m === "text" || m === "image"),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    headers: { "User-Agent": "oiia/1.0" },
    ...(thinkingLevels ? { thinkingLevelMap: Object.fromEntries(thinkingLevels.map((l) => [l, l])) } : {}),
  };
}

export function toOrcaModelInfo(row: OrcaCatalogModel): ModelInfo {
  return {
    provider: ORCAROUTER_PROVIDER,
    id: row.id,
    name: row.name,
    reasoning: row.reasoning,
    contextWindow: row.contextWindow,
    inputModalities: row.inputModalities,
  };
}

type CacheEntry = { at: number; models: OrcaCatalogModel[]; degraded: boolean };

const CACHE_TTL_MS = 5 * 60_000;
const catalogCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

/**
 * Last catalog this process actually served, so the synchronous model listing can
 * include OrcaRouter rows without a second network call. Starts as the verified seed
 * and is replaced wholesale by a live response (never merged).
 */
let latest: { models: OrcaCatalogModel[]; degraded: boolean } = {
  models: ORCA_VERIFIED_SEED,
  degraded: true,
};

export function orcaCatalogSnapshot(): { models: OrcaCatalogModel[]; degraded: boolean } {
  return latest;
}

function cacheKey(apiKey: string | undefined): string {
  if (!apiKey) return "anon";
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** Only used by tests to prove discovery is re-run per credential/cache window. */
export function resetOrcaCatalogCache(): void {
  catalogCache.clear();
  inflight.clear();
  latest = { models: ORCA_VERIFIED_SEED, degraded: true };
}

async function readBoundedBody(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ORCA_MAX_CATALOG_BYTES) {
      try { await reader.cancel(); } catch {  }
      throw new Error("orcarouter catalog response exceeded the byte bound");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Live discovery against GET <api base>/models?capability=chat.
 *
 * When it succeeds the live result is authoritative — the seed is not merged in.
 * When it fails, callers fall back to ORCA_VERIFIED_SEED and surface `degraded`.
 */
export async function fetchOrcaCatalog(apiKey: string | undefined): Promise<{ models: OrcaCatalogModel[]; degraded: boolean }> {
  const key = cacheKey(apiKey);
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { models: cached.models, degraded: cached.degraded };
  }
  const pending = inflight.get(key);
  if (pending) {
    const entry = await pending;
    return { models: entry.models, degraded: entry.degraded };
  }
  const task = (async (): Promise<CacheEntry> => {
    const url = new URL(`${orcaApiBase()}/models`);
    url.searchParams.set("capability", "chat");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORCA_CATALOG_TIMEOUT_MS);
    try {
      const request = async (withKey: boolean): Promise<Response> => {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (withKey && apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return fetch(url, { headers, signal: controller.signal });
      };
      // Prefer the user's key so the catalog reflects their workspace. The catalog is
      // also public, so a rejected or revoked key degrades to an anonymous read rather
      // than hiding every model; it is never a credential-validation probe.
      let res = await request(true);
      if (!res.ok && apiKey && (res.status === 401 || res.status === 403)) res = await request(false);
      if (!res.ok) throw new Error(`orcarouter catalog responded ${res.status}`);
      const models = parseCatalogPayload(JSON.parse(await readBoundedBody(res)));
      if (models.length === 0) throw new Error("orcarouter catalog returned no usable chat models");
      return { at: Date.now(), models, degraded: false };
    } catch {
      return { at: Date.now(), models: ORCA_VERIFIED_SEED, degraded: true };
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(key, task);
  try {
    const entry = await task;
    catalogCache.set(key, entry);
    latest = { models: entry.models, degraded: entry.degraded };
    return { models: entry.models, degraded: entry.degraded };
  } finally {
    inflight.delete(key);
  }
}

/**
 * Model rows for the dropdown at a given entry point. `modality` is the input this
 * session actually uploads; models that do not explicitly declare it are excluded.
 */
export function filterOrcaModelsForInput(
  models: OrcaCatalogModel[],
  required: "text" | "image" = "text",
): OrcaCatalogModel[] {
  if (required === "text") return models;
  return models.filter((m) => m.inputModalities.includes(required));
}

export function orcaKeyHint(key: string): string {
  return key.slice(-4);
}

export function looksLikeOrcaKey(key: string): boolean {
  // A prefix check only catches obvious input mistakes; validity is established by
  // the first real request, never by a paid probe.
  return key.startsWith(ORCAROUTER_KEY_PREFIX) && key.length > ORCAROUTER_KEY_PREFIX.length + 8;
}
