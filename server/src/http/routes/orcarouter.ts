import type express from "express";
import { errorMessage } from "../../foundation/errors.ts";
import { keyDao } from "../../persistence/index.ts";
import { decryptKey } from "../../identity/auth.ts";
import { getAuditRequestId, logAudit } from "../../observability/audit-log.ts";
import {
  ORCAROUTER_CYBER_CATALOG_URL,
  ORCAROUTER_DEFAULT_API_BASE,
  ORCAROUTER_DASHBOARD_URL,
  ORCAROUTER_KEY_PREFIX,
  ORCAROUTER_LABEL,
  ORCAROUTER_PROVIDER,
  ORCAROUTER_PROVIDER_URL,
  fetchOrcaCatalog,
  filterOrcaModelsForInput,
  orcaApiBase,
  orcaAuthBase,
} from "../../runtime/orcarouter.ts";
import {
  cancelOrcaLogin,
  clearOrcaKey,
  completeOrcaLogin,
  orcaCredentialState,
  persistOrcaKey,
  startOrcaLogin,
} from "../../runtime/orcarouter-auth.ts";
import { type AuthedRequest, requireAuth } from "../route-helpers.ts";

function userOrcaKey(userId: string): string | undefined {
  const row = keyDao.get(userId, ORCAROUTER_PROVIDER);
  if (!row) return undefined;
  try {
    return decryptKey(row.enc_key);
  } catch {
    return undefined;
  }
}

export function registerOrcaRouterRoutes(r: express.Router): void {
  /** Provider metadata for the settings panel: both authentication choices, endpoints, docs. */
  r.get("/providers/orcarouter", requireAuth, (req: AuthedRequest, res) => {
    res.json({
      provider: ORCAROUTER_PROVIDER,
      label: ORCAROUTER_LABEL,
      keyPrefix: ORCAROUTER_KEY_PREFIX,
      apiBase: orcaApiBase(),
      authBase: orcaAuthBase(),
      defaults: { apiBase: ORCAROUTER_DEFAULT_API_BASE, authBase: "https://www.orcarouter.ai" },
      dashboardUrl: ORCAROUTER_DASHBOARD_URL,
      providerUrl: ORCAROUTER_PROVIDER_URL,
      cyberCatalogUrl: ORCAROUTER_CYBER_CATALOG_URL,
      authMethods: ["api_key", "oauth_pkce"],
      credential: orcaCredentialState(req.user!.id),
    });
  });

  /** The model selector's source of truth for this provider, filtered per entry point. */
  r.get("/providers/orcarouter/models", requireAuth, async (req: AuthedRequest, res) => {
    const modality = req.query.modality === "image" ? "image" : "text";
    const catalog = await fetchOrcaCatalog(userOrcaKey(req.user!.id));
    const models = filterOrcaModelsForInput(catalog.models, modality).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      inputModalities: m.inputModalities,
      reasoning: m.reasoning,
    }));
    res.json({
      provider: ORCAROUTER_PROVIDER,
      modality,
      source: catalog.degraded ? "verified_seed" : "live",
      degraded: catalog.degraded,
      catalogUrl: `${orcaApiBase()}/models?capability=chat`,
      models,
    });
  });

  /** API-key adapter: the pasted key goes through the same persistence seam as PKCE. */
  r.put("/providers/orcarouter/key", requireAuth, (req: AuthedRequest, res) => {
    const key = String(req.body?.key ?? "").trim();
    if (key.length < 20) {
      res.status(400).json({ error: "key looks too short" });
      return;
    }
    try {
      const saved = persistOrcaKey(req.user!.id, key, "api_key", null);
      logAudit("orcarouter_key_saved", {
        requestId: getAuditRequestId(req),
        userId: req.user!.id,
        data: { source: "api_key", generation: saved.generation },
      });
      res.json({ ok: true, hint: saved.hint, generation: saved.generation, source: "api_key" });
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });

  r.delete("/providers/orcarouter/key", requireAuth, (req: AuthedRequest, res) => {
    clearOrcaKey(req.user!.id);
    logAudit("orcarouter_key_cleared", { requestId: getAuditRequestId(req), userId: req.user!.id });
    res.json({ ok: true });
  });

  /** PKCE adapter, step 1: mint a fresh verifier/state and hand back the consent URL. */
  r.post("/providers/orcarouter/login/start", requireAuth, (req: AuthedRequest, res) => {
    const appName = String(req.body?.appName ?? "").trim().slice(0, 40) || undefined;
    const attempt = startOrcaLogin(req.user!.id, appName);
    res.json({ ok: true, ...attempt, authBase: orcaAuthBase() });
  });

  /** PKCE adapter, step 2: redeem the pasted code; the verifier never leaves the server. */
  r.post("/providers/orcarouter/login/complete", requireAuth, async (req: AuthedRequest, res) => {
    const attemptId = String(req.body?.attemptId ?? "");
    const code = String(req.body?.code ?? "");
    if (!attemptId || !code) {
      res.status(400).json({ error: "attemptId and code are required" });
      return;
    }
    const result = await completeOrcaLogin(req.user!.id, attemptId, code);
    if (!result.ok) {
      logAudit("orcarouter_login_failed", {
        level: "warn", requestId: getAuditRequestId(req), userId: req.user!.id, data: { reason: result.reason },
      });
      const status = result.reason === "expired" ? 410 : result.reason === "network" ? 502 : 400;
      res.status(status).json({ error: result.message, reason: result.reason });
      return;
    }
    logAudit("orcarouter_login_succeeded", {
      requestId: getAuditRequestId(req), userId: req.user!.id, data: { source: "oauth_pkce", generation: result.generation, scope: result.scope },
    });
    res.json({ ok: true, hint: result.hint, scope: result.scope, generation: result.generation, source: "oauth_pkce" });
  });

  /** Terminal path for cancel / unmount / pagehide: release the pending attempt. */
  r.post("/providers/orcarouter/login/cancel", requireAuth, (req: AuthedRequest, res) => {
    const attemptId = String(req.body?.attemptId ?? "");
    const cancelled = attemptId ? cancelOrcaLogin(req.user!.id, attemptId) : false;
    res.json({ ok: true, cancelled });
  });
}
