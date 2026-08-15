import type express from "express";
import { connectorDao, sshTargetDao, compactionDao } from "../../persistence/index.ts";
import { boundedRuntimeClient } from "../../runtime/runtime-client.ts";
import { errorCode } from "../../foundation/errors.ts";
import { getAuditRequestId, logAudit } from "../../observability/audit-log.ts";
import { isThinkingLevel, type SandboxMode, type SandboxKind, type ApprovalPolicy } from "../../../../shared/src/protocol.ts";
import {
  type AuthedRequest,
  requireAuth,
  SANDBOX_MODES,
  APPROVAL_POLICIES,
  forkFailureMessage,
  SSH_EXECUTOR_ENABLED,
} from "../route-helpers.ts";

export function registerSessionRoutes(r: express.Router): void {
  r.get("/sessions", requireAuth, async (req: AuthedRequest, res) => {
    res.json({ sessions: await boundedRuntimeClient.listSessions(req.user!.id) });
  });

  r.post("/sessions", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { title, provider, model, sandboxMode, sandboxKind, sandboxTargetId, mode, approvalPolicy, connectorUnconfined } = req.body ?? {};
      if (!provider || !model) {
        res.status(400).json({ error: "provider and model are required" });
        return;
      }
      if (mode !== undefined && mode !== null && typeof mode !== "string") {
        res.status(400).json({ error: "mode must be a string" });
        return;
      }
      const sm: SandboxMode = SANDBOX_MODES.includes(sandboxMode) ? sandboxMode : "danger-full-access";
      const ap: ApprovalPolicy = APPROVAL_POLICIES.includes(approvalPolicy) ? approvalPolicy : "never";
      const md: string | undefined = mode == null ? undefined : mode;
      const connector =
        typeof sandboxTargetId === "string" ? connectorDao.byId(req.user!.id, sandboxTargetId) : undefined;
      const sshTarget =
        typeof sandboxTargetId === "string" ? sshTargetDao.byId(req.user!.id, sandboxTargetId) : undefined;
      if (sandboxKind === "connector" && !connector) {
        res.status(400).json({ error: "connector target is required" });
        return;
      }
      if (sandboxKind === "ssh" && (!SSH_EXECUTOR_ENABLED || !sshTarget)) {
        res.status(400).json({ error: "SSH target is required" });
        return;
      }
      const sk: SandboxKind | undefined =
        sandboxKind === "e2b"
          ? "e2b"
          : sandboxKind === "ssh" && sshTarget
            ? "ssh"
            : sandboxKind === "connector" && connector
              ? "connector"
              : sandboxKind === "local"
                ? "local"
                : undefined;
      const info = await boundedRuntimeClient.createSession(req.user!, {
        title,
        provider: String(provider),
        model: String(model),
        sandboxMode: sm,
        sandboxKind: sk,
        sandboxTargetId: sk === "connector" ? connector?.id : sk === "ssh" ? sshTarget?.id : null,
        mode: md,
        approvalPolicy: ap,
        connectorUnconfined: sk === "connector" && typeof connectorUnconfined === "boolean" ? connectorUnconfined : undefined,
      });
      logAudit("session_create", {
        requestId: getAuditRequestId(req),
        userId: req.user!.id,
        sessionId: info.id,
        targetId: info.sandboxTargetId,
        data: { provider: info.provider, model: info.model, mode: info.mode, sandboxKind: info.sandboxKind, approvalPolicy: info.approvalPolicy },
      });
      res.json({ session: info });
    } catch (e) {
      if (errorCode(e) === "invalid_skill") {
        res.status(400).json({ error: "unknown skill" });
        return;
      }
      logAudit("session_create_failed", { level: "warn", requestId: getAuditRequestId(req), userId: req.user!.id, data: { reason: e instanceof Error ? e.message : "create failed" } });
      res.status(400).json({ error: e instanceof Error ? e.message : "create failed" });
    }
  });

  r.get("/sessions/:id", requireAuth, async (req: AuthedRequest, res) => {
    const info = await boundedRuntimeClient.getSessionInfo(req.user!.id, req.params.id);
    if (!info) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ session: info });
  });

  r.patch("/sessions/:id", requireAuth, async (req: AuthedRequest, res) => {
    const { title, thinkingLevel, approvalPolicy, provider, model } = req.body ?? {};
    const hasTitle = typeof title === "string" && title.trim().length > 0;
    const validLevel = isThinkingLevel(thinkingLevel);
    const validPolicy = approvalPolicy === "never" || approvalPolicy === "on-request" || approvalPolicy === "untrusted";
    const validModel = typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0;
    if (!hasTitle && !validLevel && !validPolicy && !validModel) {
      res.status(400).json({ error: "nothing to update" });
      return;
    }
    let info = null;
    if (hasTitle) info = await boundedRuntimeClient.renameSession(req.user!.id, req.params.id, title);
    if (validLevel) info = await boundedRuntimeClient.setThinkingLevel(req.user!.id, req.params.id, thinkingLevel);
    if (validPolicy) info = await boundedRuntimeClient.setApprovalPolicy(req.user!.id, req.params.id, approvalPolicy);
    if (validModel) info = await boundedRuntimeClient.setModel(req.user!.id, req.params.id, provider, model);
    if (!info) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ session: info });
  });

  r.delete("/sessions/:id", requireAuth, async (req: AuthedRequest, res) => {
    const ok = await boundedRuntimeClient.deleteSession(req.user!.id, req.params.id);
    logAudit("session_delete", { level: ok ? "info" : "warn", requestId: getAuditRequestId(req), userId: req.user!.id, sessionId: req.params.id, data: { ok } });
    res.status(ok ? 200 : 404).json({ ok });
  });

  r.post("/sessions/:id/fork", requireAuth, async (req: AuthedRequest, res) => {
    const owned = await boundedRuntimeClient.getSessionInfo(req.user!.id, req.params.id);
    if (!owned) { res.status(404).json({ error: "not found" }); return; }
    const fromSeq = Number((req.body as { fromSeq?: unknown })?.fromSeq);
    if (!Number.isInteger(fromSeq)) { res.status(400).json({ error: "fromSeq is required" }); return; }
    const out = await boundedRuntimeClient.forkSession(req.user!.id, req.params.id, fromSeq);
    if (!out.ok) {
      logAudit("session_fork_rejected", { level: "warn", requestId: getAuditRequestId(req), userId: req.user!.id, sessionId: req.params.id, data: { fromSeq, reason: out.reason } });
      res.status(out.reason === "not found" ? 404 : 409).json({ error: forkFailureMessage(out.reason) });
      return;
    }
    logAudit("session_fork", { requestId: getAuditRequestId(req), userId: req.user!.id, sessionId: req.params.id, data: { fromSeq, newId: out.info.id } });
    res.json({ session: out.info });
  });

  r.get("/sessions/:id/timeline", requireAuth, async (req: AuthedRequest, res) => {
    const t = await boundedRuntimeClient.getSessionTimeline(req.user!.id, req.params.id);
    if (!t) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(t);
  });

  r.get("/sessions/:id/compactions/:cid", requireAuth, async (req: AuthedRequest, res) => {
    const info = await boundedRuntimeClient.getSessionInfo(req.user!.id, req.params.id);
    if (!info) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const row = compactionDao.byId(info.id, String(req.params.cid));
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    let messages: unknown[] = [];
    try {
      const parsed = JSON.parse(row.archived_json);
      if (Array.isArray(parsed)) messages = parsed;
    } catch {
    }
    const MAX_ARCHIVED = 500;
    const truncated = messages.length > MAX_ARCHIVED;
    if (truncated) messages = messages.slice(messages.length - MAX_ARCHIVED);
    res.json({
      summary: row.summary_text,
      messages,
      truncated,
      summarizedCount: row.summarized_count,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      createdAt: row.created_at,
    });
  });
}
