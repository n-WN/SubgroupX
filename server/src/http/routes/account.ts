import crypto from "node:crypto";
import type express from "express";
import { errorMessage } from "../../foundation/errors.ts";
import { decryptKey, encryptKey, verifyToken } from "../../identity/auth.ts";
import { connectorDao, keyDao, userDao, sshTargetDao, userMemoryDao, webauthnCredentialDao } from "../../persistence/index.ts";
import { isInternalIp, resolveSafeSshHost } from "../../runtime/ssh-guard.ts";
import { SSHSandbox } from "../../runtime/ssh-sandbox.ts";
import { unlockKey, lockKey, isUnlocked, resolveSshPrivateKey, SshUnlockRequiredError } from "../../runtime/ssh-unlock.ts";
import { boundedRuntimeClient } from "../../runtime/runtime-client.ts";
import { knownProviders, listModelsForProviders } from "../../runtime/providers.ts";
import { ORCAROUTER_PROVIDER, fetchOrcaCatalog } from "../../runtime/orcarouter.ts";
import { searchSessions } from "../../sessions/search.ts";
import { getAuditRequestId, hashForAudit, logAudit } from "../../observability/audit-log.ts";
import { executionDenial } from "../../identity/access-gate.ts";
import type { ProviderKeyInfo } from "../../../../shared/src/protocol.ts";
import {
  type AuthedRequest,
  requireAuth,
  sendAccessDenial,
  isLoopback,
  pairAllowed,
  SSH_EXECUTOR_ENABLED,
  CONNECTOR_DAEMON_SRC,
  CONNECTOR_INSTALLER_SRC,
} from "../route-helpers.ts";

const PROXY_URL_RE = /^(https?|socks4|socks5|socks5h):\/\/[^\s]+$/i;

function sshTargetInfo(
  t: { id: string; label: string; host: string; port: number; username: string; host_fp: string | null; key_protected?: number; created_at: number; unconfined?: number },
  userId?: string,
) {
  return {
    id: t.id,
    label: t.label,
    host: t.host,
    port: t.port,
    username: t.username,
    verified: Boolean(t.host_fp),
    protected: Boolean(t.key_protected),
    unlocked: Boolean(t.key_protected) && !!userId && isUnlocked(userId, t.id),
    unconfined: Boolean(t.unconfined),
    createdAt: t.created_at,
  };
}

export function registerAccountRoutes(r: express.Router): void {
  r.get("/providers", requireAuth, (req: AuthedRequest, res) => {
    const keys: ProviderKeyInfo[] = keyDao.list(req.user!.id).map((k) => ({
      provider: k.provider,
      hint: k.hint,
      updatedAt: k.updated_at,
    }));
    res.json({ providers: knownProviders(), keys });
  });

  r.put("/providers/:provider/key", requireAuth, (req: AuthedRequest, res) => {
    const provider = req.params.provider;
    if (!knownProviders().includes(provider)) {
      res.status(400).json({ error: "unknown provider" });
      return;
    }
    const key = String(req.body?.key ?? "").trim();
    if (key.length < 8) {
      res.status(400).json({ error: "key looks too short" });
      return;
    }
    keyDao.upsert({
      user_id: req.user!.id,
      provider,
      enc_key: encryptKey(key),
      hint: key.slice(-4),
      updated_at: Date.now(),
    });
    res.json({ ok: true });
  });

  r.delete("/providers/:provider/key", requireAuth, (req: AuthedRequest, res) => {
    keyDao.delete(req.user!.id, req.params.provider);
    res.json({ ok: true });
  });

  r.get("/settings/egress", requireAuth, (req: AuthedRequest, res) => {
    const u = userDao.byId(req.user!.id);
    res.json({ proxyUrl: u?.proxy_url ?? "", jumpServer: u?.jump_server ?? "" });
  });

  r.get("/settings/memory", requireAuth, (req: AuthedRequest, res) => {
    const memory = userMemoryDao.get(req.user!.id);
    res.json({
      enabled: memory.enabled,
      state: memory.state ?? "",
      userNotes: memory.userNotes ?? "",
      lastDreamedAt: memory.lastDreamedAt,
    });
  });

  r.patch("/settings/memory", requireAuth, (req: AuthedRequest, res) => {
    const body = req.body ?? {};
    if (typeof body.enabled === "boolean") {
      userMemoryDao.setEnabled(req.user!.id, body.enabled);
      logAudit("memory_settings_changed", {
        requestId: getAuditRequestId(req), userId: req.user!.id, data: { enabled: body.enabled },
      });
    }
    if (typeof body.userNotes === "string") {
      if (body.userNotes.length > 4000) {
        res.status(400).json({ error: "notes too long (4000 max)" });
        return;
      }
      userMemoryDao.setUserNotes(req.user!.id, body.userNotes);
    }
    const memory = userMemoryDao.get(req.user!.id);
    res.json({ ok: true, enabled: memory.enabled, userNotes: memory.userNotes ?? "" });
  });

  r.delete("/settings/memory/state", requireAuth, (req: AuthedRequest, res) => {
    userMemoryDao.clearState(req.user!.id);
    logAudit("memory_cleared", { requestId: getAuditRequestId(req), userId: req.user!.id });
    res.json({ ok: true });
  });

  r.patch("/settings/egress", requireAuth, async (req: AuthedRequest, res) => {
    const proxyUrl = typeof req.body?.proxyUrl === "string" ? req.body.proxyUrl.trim() : "";
    const jumpServer = typeof req.body?.jumpServer === "string" ? req.body.jumpServer.trim() : "";
    if (proxyUrl.length > 512 || jumpServer.length > 512) {
      res.status(400).json({ error: "value too long" });
      return;
    }
    if (proxyUrl && !PROXY_URL_RE.test(proxyUrl)) {
      res.status(400).json({ error: "proxy must be a http(s):// or socks5:// URL" });
      return;
    }
    for (const candidate of [proxyUrl, jumpServer]) {
      if (candidate && PROXY_URL_RE.test(candidate)) {
        try {
          await resolveSafeSshHost(new URL(candidate).hostname);
        } catch (e) {
          res.status(400).json({ error: e instanceof Error ? e.message : "proxy host is not allowed" });
          return;
        }
      }
    }
    userDao.setEgress(req.user!.id, proxyUrl, jumpServer);
    res.json({ ok: true, proxyUrl, jumpServer, proxyApplies: PROXY_URL_RE.test(proxyUrl || jumpServer) });
  });

  r.get("/models", requireAuth, async (req: AuthedRequest, res) => {
    const providersWithKeys = keyDao.list(req.user!.id).map((k) => k.provider);
    if (providersWithKeys.includes(ORCAROUTER_PROVIDER)) {
      // Refresh the OrcaRouter catalog before listing so the dropdown reflects the
      // live directory; discovery itself falls back to the verified seed on failure.
      let key: string | undefined;
      try {
        const row = keyDao.get(req.user!.id, ORCAROUTER_PROVIDER);
        key = row ? decryptKey(row.enc_key) : undefined;
      } catch {
        key = undefined;
      }
      await fetchOrcaCatalog(key);
    }
    const executors = await boundedRuntimeClient.getExecutorAvailability();
    res.json({ models: listModelsForProviders(providersWithKeys), e2b: executors.e2b.available, executors });
  });

  r.get("/ssh/targets", requireAuth, (req: AuthedRequest, res) => {
    res.json({
      enabled: SSH_EXECUTOR_ENABLED,
      targets: sshTargetDao.listForUser(req.user!.id).map((t) => sshTargetInfo(t, req.user!.id)),
    });
  });
  r.post("/ssh/targets", requireAuth, (req: AuthedRequest, res) => {
    if (!SSH_EXECUTOR_ENABLED) {
      res.status(403).json({ error: "SSH executor is disabled on this deployment" });
      return;
    }
    const label = String(req.body?.label ?? "").trim().slice(0, 80);
    const host = String(req.body?.host ?? "").trim();
    const username = String(req.body?.username ?? "").trim();
    const port = Number(req.body?.port ?? 22);
    if (!label || !host || !username) {
      res.status(400).json({ error: "label, host, and username are required" });
      return;
    }
    if (host.length > 255 || username.length > 64 || !Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: "invalid host, username, or port" });
      return;
    }
    if (isInternalIp(host) && process.env.AGENT_WEB_SSH_ALLOW_INTERNAL !== "1") {
      res.status(400).json({ error: `refusing internal/reserved address ${host}` });
      return;
    }
    const wrappedKey = req.body?.wrappedKey;
    let enc_key: string;
    let key_protected: number;
    if (wrappedKey != null) {
      const blob = typeof wrappedKey === "string" ? wrappedKey : JSON.stringify(wrappedKey);
      if (blob.length < 40 || blob.length > 32768 || !/"ct"/.test(blob) || !/"credentialId"/.test(blob)) {
        res.status(400).json({ error: "invalid wrappedKey envelope" });
        return;
      }
      enc_key = blob;
      key_protected = 1;
    } else {
      const privateKey = String(req.body?.privateKey ?? "");
      if (!/PRIVATE KEY/.test(privateKey) || privateKey.length < 80 || privateKey.length > 16384) {
        res.status(400).json({ error: "privateKey must be a PEM/OpenSSH private key (or pass wrappedKey for passkey protection)" });
        return;
      }
      enc_key = encryptKey(privateKey);
      key_protected = 0;
    }
    const id = "ssh_" + crypto.randomUUID();
    const created_at = Date.now();
    sshTargetDao.create({ id, user_id: req.user!.id, label, host, port, username, enc_key, host_fp: null, key_protected, created_at });
    res.json({ ok: true, target: sshTargetInfo({ id, label, host, port, username, host_fp: null, key_protected, created_at }, req.user!.id) });
  });
  r.delete("/ssh/targets/:id", requireAuth, (req: AuthedRequest, res) => {
    lockKey(req.user!.id, String(req.params.id));
    sshTargetDao.delete(req.user!.id, String(req.params.id));
    void boundedRuntimeClient.invalidateFilePreviewSandboxes(req.user!.id).catch(() => {});
    res.json({ ok: true });
  });
  r.post("/ssh/targets/:id/unlock", requireAuth, (req: AuthedRequest, res) => {
    if (!SSH_EXECUTOR_ENABLED) {
      res.status(403).json({ error: "SSH executor is disabled on this deployment" });
      return;
    }
    const t = sshTargetDao.byId(req.user!.id, String(req.params.id));
    if (!t) {
      res.status(404).json({ error: "target not found" });
      return;
    }
    if (!t.key_protected) {
      res.status(400).json({ error: "target is not passkey-protected" });
      return;
    }
    const privateKey = String(req.body?.privateKey ?? "");
    if (!/PRIVATE KEY/.test(privateKey) || privateKey.length < 80 || privateKey.length > 16384) {
      res.status(400).json({ error: "unwrapped key is not a valid PEM/OpenSSH private key" });
      return;
    }
    const expiresAt = unlockKey(req.user!.id, t.id, privateKey);
    logAudit("ssh_target_unlock", { userId: req.user!.id, data: { targetId: t.id } });
    res.json({ ok: true, expiresAt });
  });
  r.post("/ssh/targets/:id/lock", requireAuth, (req: AuthedRequest, res) => {
    lockKey(req.user!.id, String(req.params.id));
    res.json({ ok: true });
  });
  r.get("/ssh/targets/:id/wrapped", requireAuth, (req: AuthedRequest, res) => {
    const t = sshTargetDao.byId(req.user!.id, String(req.params.id));
    if (!t || !t.key_protected) {
      res.status(404).json({ error: "no wrapped key for this target" });
      return;
    }
    try {
      res.json({ wrappedKey: JSON.parse(t.enc_key) });
    } catch {
      res.status(500).json({ error: "corrupt wrapped key" });
    }
  });
  r.post("/ssh/targets/:id/test", requireAuth, async (req: AuthedRequest, res) => {
    if (!SSH_EXECUTOR_ENABLED) {
      res.status(403).json({ error: "SSH executor is disabled on this deployment" });
      return;
    }
    const denial = executionDenial(req.user!.id);
    if (denial) { sendAccessDenial(res, denial); return; }
    const t = sshTargetDao.byId(req.user!.id, String(req.params.id));
    if (!t) {
      res.status(404).json({ error: "target not found" });
      return;
    }
    let privateKey: string;
    try {
      privateKey = resolveSshPrivateKey(req.user!.id, t);
    } catch (e) {
      if (e instanceof SshUnlockRequiredError) {
        res.status(409).json({ ok: false, error: "unlock-required", needsUnlock: true });
        return;
      }
      throw e;
    }
    const sandbox = new SSHSandbox({
      root: "/tmp/oiia-conn-test",
      mode: "workspace-write",
      target: {
        host: t.host,
        port: t.port,
        username: t.username,
        privateKey,
        hostFingerprint: t.host_fp,
        onFingerprint: (fp) => sshTargetDao.setFingerprint(t.id, fp),
      },
    });
    try {
      const r2 = await sandbox.exec("echo oiia-ssh-ok", { timeoutMs: 15_000 });
      const ok = r2.exitCode === 0 && r2.stdout.includes("oiia-ssh-ok");
      res.json({ ok, output: r2.stdout.trim().slice(0, 200) || r2.stderr.trim().slice(0, 200) });
    } catch (e) {
      res.json({ ok: false, error: errorMessage(e) });
    } finally {
      sandbox.close();
    }
  });

  r.get("/webauthn/credentials", requireAuth, (req: AuthedRequest, res) => {
    res.json({
      credentials: webauthnCredentialDao.listForUser(req.user!.id).map((c) => ({
        id: c.id,
        credentialId: c.credential_id,
        label: c.label,
        transports: c.transports ? (JSON.parse(c.transports) as string[]) : [],
        createdAt: c.created_at,
      })),
    });
  });
  r.post("/webauthn/credentials", requireAuth, (req: AuthedRequest, res) => {
    const credentialId = String(req.body?.credentialId ?? "").trim();
    const label = String(req.body?.label ?? "").trim().slice(0, 80) || "Passkey";
    const transports = Array.isArray(req.body?.transports)
      ? (req.body.transports as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8)
      : [];
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(credentialId)) {
      res.status(400).json({ error: "invalid credentialId" });
      return;
    }
    const id = "wac_" + crypto.randomUUID();
    const created_at = Date.now();
    try {
      webauthnCredentialDao.create({ id, user_id: req.user!.id, credential_id: credentialId, label, transports: JSON.stringify(transports), created_at });
    } catch {
      res.status(409).json({ error: "passkey already enrolled" });
      return;
    }
    logAudit("webauthn_credential_add", { userId: req.user!.id, data: { credentialId: credentialId.slice(0, 12) } });
    res.json({ ok: true, credential: { id, credentialId, label, transports, createdAt: created_at } });
  });
  r.delete("/webauthn/credentials/:id", requireAuth, (req: AuthedRequest, res) => {
    webauthnCredentialDao.delete(req.user!.id, String(req.params.id));
    res.json({ ok: true });
  });

  const clientLogHits = new Map<string, { count: number; resetAt: number }>();
  const ANON_KINDS = new Set(["api_network_error", "window_error", "unhandled_rejection", "ws_abnormal_close"]);
  r.post("/client-log", (req: AuthedRequest, res) => {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const user = bearer ? verifyToken(bearer) : null;
    const anonymous = !user;
    const now = Date.now();
    const bucket = user ? `u:${user.id}` : `ip:${hashForAudit(req.ip)}`;
    const budget = anonymous ? 20 : 60;
    const hit = clientLogHits.get(bucket);
    if (!hit || now > hit.resetAt) clientLogHits.set(bucket, { count: 1, resetAt: now + 60_000 });
    else if (++hit.count > budget) { res.status(429).json({ error: "too many events" }); return; }
    if (clientLogHits.size > 5000) {
      for (const [k, v] of clientLogHits) if (now > v.resetAt) clientLogHits.delete(k);
    }
    const events = Array.isArray(req.body?.events) ? (req.body.events as unknown[]).slice(0, anonymous ? 5 : 10) : [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const ev = raw as { kind?: unknown; message?: unknown; sessionId?: unknown; path?: unknown };
      const kind = String(ev.kind ?? "error").slice(0, 40).replace(/[^\w.-]/g, "_");
      if (anonymous && !ANON_KINDS.has(kind)) continue;
      logAudit("client_error", {
        level: "warn",
        requestId: getAuditRequestId(req),
        userId: user?.id,
        sessionId: !anonymous && typeof ev.sessionId === "string" ? ev.sessionId.slice(0, 64) : undefined,
        data: {
          kind,
          message: String(ev.message ?? "").slice(0, 500),
          path: typeof ev.path === "string" ? ev.path.slice(0, 200) : undefined,
          ua: String(req.headers["user-agent"] ?? "").slice(0, 120),
          ...(anonymous ? { anonymous: true, ipHash: hashForAudit(req.ip) } : {}),
        },
      });
    }
    res.json({ ok: true });
  });

  r.get("/connectors/install.sh", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("text/x-shellscript; charset=utf-8").send(CONNECTOR_INSTALLER_SRC);
  });
  r.get("/connectors/agent-web-connector.mjs", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript; charset=utf-8").send(CONNECTOR_DAEMON_SRC);
  });

  r.post("/connectors/pair", async (req, res) => {
    const ip = req.ip ?? "";
    if (!isLoopback(ip) && !pairAllowed(ip)) {
      logAudit("connector_pair_rate_limited", { level: "warn", requestId: getAuditRequestId(req), data: { ipHash: hashForAudit(ip) } });
      res.status(429).json({ error: "too many requests" });
      return;
    }
    const code = String(req.body?.code ?? "").trim();
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const workspaceRoot = typeof req.body?.workspaceRoot === "string" ? req.body.workspaceRoot : undefined;
    if (!code) {
      res.status(400).json({ error: "pairing code is required" });
      return;
    }
    try {
      const { token, info } = await boundedRuntimeClient.connectorRedeemPairing(code, { name, workspaceRoot });
      logAudit("connector_pair_redeemed_http", { requestId: getAuditRequestId(req), targetId: info.id, data: { workspaceRootBytes: Buffer.byteLength(info.workspaceRoot) } });
      res.json({ ok: true, connector: info, token });
    } catch (e) {
      logAudit("connector_pair_failed_http", { level: "warn", requestId: getAuditRequestId(req), data: { reason: e instanceof Error ? e.message : "pairing failed", ipHash: hashForAudit(ip) } });
      res.status(400).json({ error: e instanceof Error ? e.message : "pairing failed" });
    }
  });

  r.get("/connectors", requireAuth, async (req: AuthedRequest, res) => {
    res.json({ connectors: await boundedRuntimeClient.connectorList(req.user!.id) });
  });
  r.get("/connectors/:id/telemetry", requireAuth, async (req: AuthedRequest, res) => {
    const connector = connectorDao.byId(req.user!.id, String(req.params.id));
    if (!connector) {
      res.status(404).json({ error: "connector not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    try {
      const telemetry = await boundedRuntimeClient.connectorTelemetry(connector.id);
      if (!telemetry) {
        res.status(502).json({ error: "connector telemetry unavailable" });
        return;
      }
      res.json({ telemetry });
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes("offline") ? 409 : 502).json({
        error: message.includes("offline") ? "connector is offline" : "connector telemetry unavailable",
      });
    }
  });
  r.post("/connectors/pairings", requireAuth, async (req: AuthedRequest, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const workspaceRoot = String(req.body?.workspaceRoot ?? "~/.agent-web/workspaces").trim().slice(0, 512);
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!workspaceRoot || workspaceRoot.includes("\0")) {
      res.status(400).json({ error: "workspaceRoot is required" });
      return;
    }
    const { code, pairing } = await boundedRuntimeClient.connectorCreatePairing(req.user!.id, name, workspaceRoot);
    logAudit("connector_pairing_created_http", {
      requestId: getAuditRequestId(req),
      userId: req.user!.id,
      targetId: pairing.id,
      data: { workspaceRootBytes: Buffer.byteLength(workspaceRoot), expiresAt: pairing.expiresAt },
    });
    res.json({ ok: true, pairing, code });
  });
  r.post("/connectors", requireAuth, async (req: AuthedRequest, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const workspaceRoot = String(req.body?.workspaceRoot ?? "~/.agent-web/workspaces").trim().slice(0, 512);
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!workspaceRoot || workspaceRoot.includes("\0")) {
      res.status(400).json({ error: "workspaceRoot is required" });
      return;
    }
    const { token, info } = await boundedRuntimeClient.connectorCreateToken(req.user!.id, name, workspaceRoot);
    logAudit("connector_token_created_http", {
      requestId: getAuditRequestId(req),
      userId: req.user!.id,
      targetId: info.id,
      data: { workspaceRootBytes: Buffer.byteLength(workspaceRoot) },
    });
    res.json({ ok: true, connector: info, token });
  });
  r.delete("/connectors/:id", requireAuth, async (req: AuthedRequest, res) => {
    await boundedRuntimeClient.connectorDelete(req.user!.id, String(req.params.id));
    logAudit("connector_deleted_http", { requestId: getAuditRequestId(req), userId: req.user!.id, targetId: String(req.params.id) });
    res.json({ ok: true });
  });
  r.patch("/connectors/:id", requireAuth, (req: AuthedRequest, res) => {
    const connector = connectorDao.byId(req.user!.id, String(req.params.id));
    if (!connector) { res.status(404).json({ error: "connector not found" }); return; }
    if (typeof req.body?.unconfined !== "boolean") { res.status(400).json({ error: "unconfined (boolean) required" }); return; }
    connectorDao.setUnconfined(req.user!.id, connector.id, req.body.unconfined);
    void boundedRuntimeClient.refreshTargetRuntimes(req.user!.id, "connector", connector.id).catch(() => {});
    logAudit("connector_unconfined_set", { requestId: getAuditRequestId(req), userId: req.user!.id, targetId: connector.id, data: { unconfined: req.body.unconfined } });
    res.json({ ok: true, unconfined: req.body.unconfined });
  });
  r.patch("/ssh-targets/:id", requireAuth, (req: AuthedRequest, res) => {
    const t = sshTargetDao.byId(req.user!.id, String(req.params.id));
    if (!t) { res.status(404).json({ error: "ssh target not found" }); return; }
    if (typeof req.body?.unconfined !== "boolean") { res.status(400).json({ error: "unconfined (boolean) required" }); return; }
    sshTargetDao.setUnconfined(req.user!.id, t.id, req.body.unconfined);
    void boundedRuntimeClient.refreshTargetRuntimes(req.user!.id, "ssh", t.id).catch(() => {});
    logAudit("ssh_target_unconfined_set", { requestId: getAuditRequestId(req), userId: req.user!.id, targetId: t.id, data: { unconfined: req.body.unconfined } });
    res.json({ ok: true, unconfined: req.body.unconfined });
  });
  r.post("/connectors/:id/test", requireAuth, async (req: AuthedRequest, res) => {
    const denial = executionDenial(req.user!.id);
    if (denial) { sendAccessDenial(res, denial); return; }
    const connector = connectorDao.byId(req.user!.id, String(req.params.id));
    if (!connector) {
      res.status(404).json({ error: "connector not found" });
      return;
    }
    try {
      const r2 = await boundedRuntimeClient.connectorTestExec(connector.id, {
        sessionId: "healthcheck",
        command: "printf 'oiia-connector-ok\\n'; pwd",
        timeoutMs: 15_000,
      });
      const ok = r2.exitCode === 0 && r2.stdout.includes("oiia-connector-ok");
      logAudit("connector_test_finished", {
        level: ok ? "info" : "warn",
        requestId: getAuditRequestId(req),
        userId: req.user!.id,
        targetId: connector.id,
        data: { ok, exitCode: r2.exitCode, timedOut: r2.timedOut },
      });
      res.json({ ok, output: (r2.stdout || r2.stderr).trim().slice(0, 300) });
    } catch (e) {
      logAudit("connector_test_failed", { level: "warn", requestId: getAuditRequestId(req), userId: req.user!.id, targetId: connector.id, data: { reason: errorMessage(e) } });
      res.json({ ok: false, error: errorMessage(e) });
    }
  });

  r.get("/search", requireAuth, (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? "");
    res.json(searchSessions(req.user!.id, q));
  });
}
