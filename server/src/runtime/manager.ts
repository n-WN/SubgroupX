import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { errorMessage } from "../foundation/errors.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionDao, agentTurnDao, agentNodeDao, userDao, timelineDao, messageDao, compactionDao, connectorDao, sshTargetDao, keyDao, runtimeTaskDao, taskResultDao, orchestrationRevisionDao, teamDao, teamTaskDao, workflowDao, runInImmediateTransaction, runInTransaction, normalizeSessionTitle, type RunnableBackgroundRoot, type SessionRow } from "../persistence/index.ts";
import {
  copyWorkspaceBestEffort,
  closeFilePreviewSandboxes,
  invalidateFilePreviewSandboxes as invalidateOwnedFilePreviewSandboxes,
  prepareFilePreview as prepareFilePreviewOwned,
  readFilePreviewChunk as readFilePreviewChunkOwned,
  type ReadFilePreviewChunkOptions,
} from "../workspace/file-explorer.ts";
import { logAudit } from "../observability/audit-log.ts";
import { workspacePathFor } from "./sandbox.ts";
import { connectorManager, type ConnectorExecParams } from "./connector-manager.ts";
import { evalEgress } from "./proxy-env.ts";
import { resolveModel, listModelsForProviders } from "./providers.ts";
import { AgentSessionRuntime, InvalidStoredSkillError } from "./agent-session.ts";
import { skillRegistry } from "./skill-registry.ts";
import { executionDenial } from "../identity/access-gate.ts";
import {
  RuntimeTaskPermitPool,
  runtimeTaskPermitPool,
  type RuntimeTaskPermitPoolStats,
} from "../orchestration/runtime-task-permits.ts";
import type { WorkflowSchedulerControl } from "../orchestration/workflow-scheduler.ts";
import type { WorkflowCancellationTarget } from "../persistence/workflow.ts";
import {
  ExecutorUnavailableError,
  executorAvailability as currentExecutorAvailability,
} from "./executor-availability.ts";
import type {
  ExecutorAvailability,
  SessionInfo,
  SandboxMode,
  SandboxKind,
  ApprovalPolicy,
  ThinkingLevel,
  ServerEvent,
  SessionStatus,
  TimelineItem,
} from "../../../shared/src/protocol.ts";
import type {
  OrchestrationInvalidation,
  RuntimeTask,
  TaskResultAcknowledgeOutcome,
  Workflow,
} from "../../../shared/src/orchestration.ts";
import { orchestrationReadModel } from "../orchestration/read-model.ts";
import type { AuthedUser } from "../identity/auth.ts";
import { assertAuthEpochInWriterTransaction } from "./auth-epoch.ts";
import {
  TeamTurnExecutor,
  type TeamSessionTurnRuntime,
} from "../orchestration/team-turn-executor.ts";
import {
  reconcileTeamProvisioning,
  type TeamProvisioningReconcileStats,
} from "../orchestration/team-provisioning-reconciler.ts";
import type { ReservedTeamSessionClaim } from "../orchestration/team-coordinator.ts";
import { TeamCommandService } from "../orchestration/team-command-service.ts";

export class InvalidSkillError extends Error {
  readonly code = "invalid_skill";
  constructor(skill: string) {
    super(`unknown skill: ${skill}`);
    this.name = "InvalidSkillError";
  }
}

export interface CreateSessionInput {
  title?: string;
  provider: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxKind?: SandboxKind;
  sandboxTargetId?: string | null;
  mode?: string;
  approvalPolicy: ApprovalPolicy;
  connectorUnconfined?: boolean;
}

interface Persona {
  mode: string;
  skillPrompt: string | null;
  securityMode: boolean;
}

export interface RuntimeResolutionProfile {
  runtime: AgentSessionRuntime | null;
  reused: boolean;
  rowLookupMs: number;
  constructMs: number;
  totalMs: number;
}

export interface RuntimeTaskDispatchControl {
  hint(userId?: string): void;
  continueScan(): void;
  reject(rootAgentId: string): void;
  stopClaiming(): void;
}

export type RuntimeTaskRootActivation =
  | "activated"
  | "already-active"
  | "denied"
  | "draining"
  | "missing"
  | "unsupported"
  | "no-capacity";

export interface SessionManagerOptions {
  taskPermits?: RuntimeTaskPermitPool;
  teamAttemptDetachGraceMs?: number;
}

const DEFAULT_TEAM_ATTEMPT_DETACH_GRACE_MS = 1_000;
const MAX_TEAM_ATTEMPT_DETACH_GRACE_MS = 30_000;

function boundedTeamAttemptDetachGrace(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TEAM_ATTEMPT_DETACH_GRACE_MS) {
    throw new RangeError(`Team attempt detach grace must be from 1 to ${MAX_TEAM_ATTEMPT_DETACH_GRACE_MS} ms`);
  }
  return value;
}

async function awaitTeamAttemptSettlement(
  attempt: Promise<void>,
  graceMs: number,
): Promise<"settled" | "detached"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detached = new Promise<"detached">((resolve) => {
    timer = setTimeout(() => resolve("detached"), graceMs);
  });
  const settled = attempt.then(() => "settled" as const, () => "settled" as const);
  const result = await Promise.race([settled, detached]);
  if (timer) clearTimeout(timer);
  return result;
}

function rowToInfo(row: SessionRow): SessionInfo {
  const owner = userDao.byId(row.user_id);
  const egress = evalEgress(owner?.proxy_url, owner?.jump_server);
  const tid = row.sandbox_target_id ?? null;
  const targetName =
    row.sandbox_kind === "connector"
      ? (tid ? connectorDao.byId(row.user_id, tid)?.name ?? null : null)
      : row.sandbox_kind === "ssh"
        ? (tid ? sshTargetDao.byId(row.user_id, tid)?.username ?? null : null)
        : row.sandbox_kind === "e2b"
          ? "E2B"
          : null;
  return {
    id: row.id,
    userId: row.user_id,
    title: normalizeSessionTitle(row.title, "Untitled session"),
    provider: row.provider,
    model: row.model,
    sandboxMode: row.sandbox_mode,
    sandboxKind: row.sandbox_kind,
    sandboxTargetId: tid,
    targetName,
    mode: row.mode,
    approvalPolicy: row.approval_policy,
    status: row.status,
    thinkingLevel: row.thinking_level ?? "medium",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cwd: row.cwd,
    egress,
    ...(row.team_provision_team_id && row.team_provision_state === "published"
      ? { isTeamMemberSession: true }
      : {}),
  };
}

function forkTitle(srcTitle: string): string {
  const base = srcTitle.replace(/^Fork of /, "").trim() || "Untitled session";
  return normalizeSessionTitle(`Fork of ${base}`, "Untitled session");
}

export class SessionManager {
  private static readonly ORCHESTRATION_DIRTY_MAX = 256;
  private runtimes = new Map<string, AgentSessionRuntime>();
  private idleReleaseTimers = new Map<string, { userId: string; scheduledAt: number; timer: ReturnType<typeof setTimeout> }>();
  private statusFeeds = new Map<string, Set<(ev: ServerEvent) => void>>();
  private orchestrationDirty = new Map<string, Map<string, OrchestrationInvalidation>>();
  private orchestrationFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private orchestrationSnapshotDirty = new Set<string>();
  private orchestrationPublished = new Map<string, Map<string, number>>();
  private draining = false;
  private readonly taskPermits: RuntimeTaskPermitPool;
  private readonly teamAttemptDetachGraceMs: number;
  private taskDispatchControl: RuntimeTaskDispatchControl | undefined;
  private workflowSchedulerControl: WorkflowSchedulerControl | undefined;
  private readonly liveTeamTasks = new Set<string>();

  constructor(options: SessionManagerOptions = {}) {
    this.taskPermits = options.taskPermits ?? runtimeTaskPermitPool;
    this.teamAttemptDetachGraceMs = boundedTeamAttemptDetachGrace(
      options.teamAttemptDetachGraceMs ?? DEFAULT_TEAM_ATTEMPT_DETACH_GRACE_MS,
    );
  }

  attachRuntimeTaskDispatcher(control: RuntimeTaskDispatchControl): () => void {
    if (this.taskDispatchControl && this.taskDispatchControl !== control) {
      throw new Error("SessionManager already has a RuntimeTaskDispatcher");
    }
    this.taskDispatchControl = control;
    this.taskPermits.setCapacityListener((signal) => {
      if (signal === "offer-consumed") this.taskDispatchControl?.continueScan();
      else this.taskDispatchControl?.hint();
    });
    return () => {
      if (this.taskDispatchControl !== control) return;
      this.taskDispatchControl = undefined;
      this.taskPermits.setCapacityListener(undefined);
      this.taskPermits.clearOffers();
    };
  }

  runtimeTaskDispatchCapacity(): RuntimeTaskPermitPoolStats {
    return this.taskPermits.stats();
  }

  attachWorkflowScheduler(control: WorkflowSchedulerControl): () => void {
    if (this.workflowSchedulerControl && this.workflowSchedulerControl !== control) {
      throw new Error("SessionManager already has a WorkflowScheduler");
    }
    this.workflowSchedulerControl = control;
    return () => {
      if (this.workflowSchedulerControl === control) this.workflowSchedulerControl = undefined;
    };
  }

  hintRuntimeTasks(userId: string): void {
    this.taskDispatchControl?.hint(userId);
  }

  notifyWorkflowChanged(workflow: Workflow): void {
    this.markOrchestrationDirty(workflow.userId, {
      resource: "workflow",
      workflowId: workflow.id,
      version: workflow.version,
    });
    const revision = agentNodeDao.addressableRosterRevision(workflow.userId, workflow.rootAgentId);
    if (revision !== undefined) {
      this.markOrchestrationDirty(workflow.userId, {
        resource: "session_run",
        sessionId: workflow.ownerSessionId,
        revision,
      });
    }
    this.markOrchestrationDirty(workflow.userId, {
      resource: "activity",
      revision: orchestrationRevisionDao.activity(workflow.userId),
    });
  }

  notifyWorkflowTaskChanged(userId: string, taskId: string): void {
    const task = runtimeTaskDao.byId(userId, taskId);
    if (!task?.workflowId) return;
    const workflow = workflowDao.snapshot(userId, task.workflowId)?.workflow;
    if (workflow) this.notifyWorkflowChanged(workflow);
    this.workflowSchedulerControl?.hint(userId, task.workflowId);
  }

  notifyTeamTaskChanged(userId: string, task: RuntimeTask): void {
    if (task.userId !== userId || task.kind !== "team_turn") return;
    if (task.teamId) {
      const version = teamDao.revision(userId, task.teamId);
      if (version !== undefined) {
        this.markOrchestrationDirty(userId, {
          resource: "team",
          teamId: task.teamId,
          version,
        });
      }
    }
    const agent = agentNodeDao.byId(userId, task.agentId);
    const revision = agent
      ? agentNodeDao.addressableRosterRevision(userId, agent.rootAgentId)
      : undefined;
    if (revision !== undefined) {
      this.markOrchestrationDirty(userId, {
        resource: "session_run",
        sessionId: task.sessionId,
        revision,
      });
    }
    this.markOrchestrationDirty(userId, {
      resource: "activity",
      revision: orchestrationRevisionDao.activity(userId),
    });
  }

  interruptWorkflowTask(target: WorkflowCancellationTarget): boolean {
    const runtime = this.runtimes.get(target.sessionId);
    if (
      !runtime
      || runtime.userId !== target.userId
      || runtime.getRootAgentId() !== target.rootAgentId
    ) return false;
    return runtime.interruptBackgroundTask(target.taskId, target.expectedTaskLeaseGeneration);
  }

  activateRuntimeTaskRoot(candidate: RunnableBackgroundRoot): RuntimeTaskRootActivation {
    if (this.draining) return "draining";
    const session = sessionDao.byId(candidate.sessionId);
    const root = agentNodeDao.byId(candidate.userId, candidate.rootAgentId);
    const task = runtimeTaskDao.byId(candidate.userId, candidate.taskId);
    const taskAgent = task ? agentNodeDao.byId(candidate.userId, task.agentId) : undefined;
    if (
      !session
      || session.user_id !== candidate.userId
      || !root
      || root.id !== root.rootAgentId
      || root.sessionId !== session.id
      || root.status === "closed"
    ) return "missing";
    if (
      !task
      || !taskAgent
      || task.sessionId !== session.id
      || (task.awaitPolicy !== "background" && task.kind !== "team_turn")
      || task.status !== "queued"
      || taskAgent.rootAgentId !== root.id
      || task.kind !== candidate.taskKind
      || taskAgent.kind !== candidate.agentKind
    ) return "missing";
    if (task.kind === "team_turn" && taskAgent.kind === "session" && taskAgent.id === root.id) {
      if (executionDenial(candidate.userId, { includeDraining: true })) return "denied";
      if (this.liveTeamTasks.has(task.id)) return "already-active";
      if (!this.taskPermits.offer(candidate.rootAgentId)) {
        return this.taskPermits.hasOffer(candidate.rootAgentId) ? "already-active" : "no-capacity";
      }
      const release = this.taskPermits.acquire(candidate.rootAgentId);
      if (!release) {
        this.taskPermits.revoke(candidate.rootAgentId);
        return "no-capacity";
      }
      this.liveTeamTasks.add(task.id);
      const executor = new TeamTurnExecutor({
        userId: candidate.userId,
        onChanged: ({ task: changedTask }) =>
          this.notifyTeamTaskChanged(candidate.userId, changedTask),
        gateway: {
          activateSession: (userId, sessionId) => this.activateTeamSession(userId, sessionId),
          executionGate: (userId) => this.teamExecutionGate(userId),
          retireSessionTurn: (userId, sessionId, taskId, turnId, reason) =>
            this.retireTeamSessionTurn(userId, sessionId, taskId, turnId, reason),
        },
      });
      const completion = executor.execute(task.id);
      let terminalStatus: Awaited<typeof completion>["status"] | "threw" = "threw";
      void completion.then(
        (outcome) => {
          terminalStatus = outcome.status;
          const attempt = "attemptSettled" in outcome ? outcome.attemptSettled : undefined;
          if (!attempt) return undefined;
          return awaitTeamAttemptSettlement(attempt, this.teamAttemptDetachGraceMs).then((state) => {
            if (state !== "detached") return;
            logAudit("team_task_attempt_detached", {
              level: "warn",
              userId: candidate.userId,
              sessionId: candidate.sessionId,
              data: { taskId: task.id, graceMs: this.teamAttemptDetachGraceMs },
            });
          });
        },
        (error) => {
          logAudit("team_task_dispatch_error", {
            level: "error",
            userId: candidate.userId,
            sessionId: candidate.sessionId,
            data: { taskId: task.id, reason: errorMessage(error) },
          });
        },
      ).finally(() => {
        this.liveTeamTasks.delete(task.id);
        release();
        if (terminalStatus === "parked" || terminalStatus === "skipped" || terminalStatus === "threw") {
          this.taskDispatchControl?.reject(candidate.rootAgentId);
        } else {
          this.taskDispatchControl?.hint(candidate.userId);
        }
        const runtime = this.runtimes.get(candidate.sessionId);
        if (runtime) this.releaseAfterBackgroundAttempt(candidate.userId, candidate.sessionId, runtime);
      });
      return "activated";
    }
    if (
      taskAgent.kind !== "subagent"
      || (task.kind !== "delegation" && task.kind !== "workflow_node")
    ) return "unsupported";
    if (executionDenial(candidate.userId, { includeDraining: true })) return "denied";
    if (!this.taskPermits.offer(candidate.rootAgentId)) {
      return this.taskPermits.hasOffer(candidate.rootAgentId) ? "already-active" : "no-capacity";
    }
    try {
      const runtime = this.resolveRuntime(candidate.userId, candidate.sessionId, undefined, "background-task");
      if (!runtime || runtime.getRootAgentId() !== candidate.rootAgentId) {
        this.taskPermits.revoke(candidate.rootAgentId);
        return "missing";
      }
      runtime.pokeBackgroundTasks();
      return "activated";
    } catch (error) {
      this.taskPermits.revoke(candidate.rootAgentId);
      throw error;
    }
  }

  subscribeUserStatus(userId: string, fn: (ev: ServerEvent) => void): () => void {
    let set = this.statusFeeds.get(userId);
    if (!set) this.statusFeeds.set(userId, (set = new Set()));
    set.add(fn);
    try {
      const snapshot = orchestrationReadModel.invalidationSnapshot(userId);
      let published = this.orchestrationPublished.get(userId);
      if (!published) this.orchestrationPublished.set(userId, (published = new Map()));
      published.set("activity", Math.max(published.get("activity") ?? 0, snapshot.activityRevision));
      for (const run of snapshot.sessionRuns) {
        const key = `session:${run.sessionId}`;
        published.set(key, Math.max(published.get(key) ?? 0, run.revision));
      }
      while (published.size > 256) published.delete(published.keys().next().value!);
      fn({
        type: "orchestration_invalidation_snapshot",
        snapshot,
      });
    } catch (error) {
      console.error("[orchestration-feed] snapshot listener failed:", error instanceof Error ? error.message : error);
    }
    return () => {
      const s = this.statusFeeds.get(userId);
      if (s) {
        s.delete(fn);
        if (s.size === 0) {
          this.statusFeeds.delete(userId);
          this.orchestrationDirty.delete(userId);
          const timer = this.orchestrationFlushTimers.get(userId);
          if (timer) clearTimeout(timer);
          this.orchestrationFlushTimers.delete(userId);
          this.orchestrationSnapshotDirty.delete(userId);
          this.orchestrationPublished.delete(userId);
        }
      }
    };
  }

  liveSessionStatuses(userId: string): { sessionId: string; status: SessionStatus }[] {
    const out: { sessionId: string; status: SessionStatus }[] = [];
    for (const [sid, rt] of this.runtimes) {
      if (rt.userId === userId) out.push({ sessionId: sid, status: rt.getStatus() });
    }
    return out;
  }

  liveSessionActivities(userId: string): { sessionId: string; activity: SessionStatus }[] {
    const out: { sessionId: string; activity: SessionStatus }[] = [];
    for (const [sid, rt] of this.runtimes) {
      if (rt.userId === userId) out.push({ sessionId: sid, activity: rt.getActivityStatus() });
    }
    return out;
  }

  private emitUserStatus(userId: string, ev: ServerEvent): void {
    const set = this.statusFeeds.get(userId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(ev);
      } catch (error) {
        console.error("[status-feed] listener failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  private markOrchestrationDirty(userId: string, change: OrchestrationInvalidation): void {
    try {
      if ((this.statusFeeds.get(userId)?.size ?? 0) === 0) return;
      let dirty = this.orchestrationDirty.get(userId);
      if (!dirty) this.orchestrationDirty.set(userId, (dirty = new Map()));
      const key = change.resource === "activity"
        ? "activity"
        : change.resource === "session_run"
          ? `session:${change.sessionId}`
          : change.resource === "workflow"
            ? `workflow:${change.workflowId}`
            : `team:${change.teamId}`;
      const version = "revision" in change ? change.revision : change.version;
      const previous = dirty.get(key);
      const previousVersion = previous
        ? ("revision" in previous ? previous.revision : previous.version)
        : this.orchestrationPublished.get(userId)?.get(key);
      if (previousVersion !== undefined && version <= previousVersion) return;
      if (
        !dirty.has(key)
        && dirty.size >= SessionManager.ORCHESTRATION_DIRTY_MAX
      ) {
        dirty.clear();
        this.orchestrationSnapshotDirty.add(userId);
      } else if (!this.orchestrationSnapshotDirty.has(userId)) {
        dirty.set(key, change);
      }
      if (this.orchestrationFlushTimers.has(userId)) return;
      const timer = setTimeout(() => {
        this.orchestrationFlushTimers.delete(userId);
        this.flushOrchestrationDirty(userId);
      }, 24);
      timer.unref?.();
      this.orchestrationFlushTimers.set(userId, timer);
    } catch (error) {
      console.error("[orchestration-feed] dirty latch failed:", error instanceof Error ? error.message : error);
    }
  }

  private flushOrchestrationDirty(userId: string): void {
    if ((this.statusFeeds.get(userId)?.size ?? 0) === 0) {
      this.orchestrationDirty.delete(userId);
      this.orchestrationSnapshotDirty.delete(userId);
      this.orchestrationPublished.delete(userId);
      return;
    }
    const dirty = this.orchestrationDirty.get(userId);
    const snapshotDirty = this.orchestrationSnapshotDirty.delete(userId);
    if (!dirty && !snapshotDirty) return;
    this.orchestrationDirty.delete(userId);
    if (snapshotDirty) {
      try {
        const snapshot = orchestrationReadModel.invalidationSnapshot(userId);
        const published = new Map<string, number>();
        published.set("activity", snapshot.activityRevision);
        for (const run of snapshot.sessionRuns) published.set(`session:${run.sessionId}`, run.revision);
        this.orchestrationPublished.set(userId, published);
        this.emitUserStatus(userId, { type: "orchestration_invalidation_snapshot", snapshot });
      } catch (error) {
        console.error("[orchestration-feed] overflow snapshot failed:", error instanceof Error ? error.message : error);
      }
      return;
    }
    if (!dirty) return;
    for (const change of dirty.values()) {
      const key = change.resource === "activity"
        ? "activity"
        : change.resource === "session_run"
          ? `session:${change.sessionId}`
          : change.resource === "workflow"
            ? `workflow:${change.workflowId}`
            : `team:${change.teamId}`;
      let published = this.orchestrationPublished.get(userId);
      if (!published) this.orchestrationPublished.set(userId, (published = new Map()));
      published.delete(key);
      published.set(key, "revision" in change ? change.revision : change.version);
      while (published.size > 256) published.delete(published.keys().next().value!);
      this.emitUserStatus(userId, { type: "orchestration_invalidated", ...change });
    }
  }

  getExecutorAvailability(): ExecutorAvailability {
    return currentExecutorAvailability();
  }

  private resolvePersona(userId: string, mode: string | undefined): Persona {
    if (mode == null) return { mode: "coding", skillPrompt: null, securityMode: false };
    const spec = skillRegistry.resolve(userId, mode);
    if (!spec) throw new InvalidSkillError(mode);
    return {
      mode: spec.id,
      skillPrompt: spec.source === "user" ? skillRegistry.basePrompt(spec) : null,
      securityMode: spec.isSecurity,
    };
  }

  createSession(user: AuthedUser, input: CreateSessionInput): SessionInfo {
    return this.createSessionForPersona(user, input, this.resolvePersona(user.id, input.mode));
  }

  private createSessionForPersona(
    user: AuthedUser,
    input: CreateSessionInput,
    persona: Persona,
    teamClaim?: ReservedTeamSessionClaim,
  ): SessionInfo {
    resolveModel(input.provider, input.model);

    const activeClaim = () => Boolean(teamClaim && teamDao.isActiveMemberProvisionClaim({
      reservationId: teamClaim.reservationId,
      userId: user.id,
      sessionId: teamClaim.sessionId,
      generation: teamClaim.generation,
      claimToken: teamClaim.claimToken,
      at: Date.now(),
    }));
    if (teamClaim && !activeClaim()) {
      throw new Error("Team Session provision claim is no longer active");
    }
    const id = teamClaim?.sessionId ?? "s_" + crypto.randomUUID();
    const existing = sessionDao.byId(id);
    if (existing) {
      if (
        existing.user_id !== user.id
        || !teamClaim
        || existing.team_provision_reservation_id !== teamClaim.reservationId
        || existing.team_provision_team_id !== teamClaim.teamId
        || existing.team_provision_state !== "provisional"
        || !activeClaim()
      ) {
        throw new Error("Session id already exists");
      }
      return rowToInfo(existing);
    }
    const now = Date.now();
    const { mode, skillPrompt, securityMode } = persona;
    const executors = currentExecutorAvailability();
    let sandboxKind: SandboxKind =
      input.sandboxKind === "e2b"
        ? "e2b"
        : input.sandboxKind === "ssh"
          ? "ssh"
          : input.sandboxKind === "connector"
            ? "connector"
            : input.sandboxKind === "local"
              ? "local"
              : securityMode && executors.e2b.available
                ? "e2b"
                : "local";
    if (sandboxKind === "e2b" && !executors.e2b.available) {
      throw new ExecutorUnavailableError("e2b", executors.e2b.reason ?? "policy_disabled");
    }
    if (sandboxKind === "local" && !executors.local.available) {
      if (executors.e2b.available) sandboxKind = "e2b";
      else if (executors.e2b.reason === "capacity_unavailable") {
        throw new ExecutorUnavailableError("e2b", "capacity_unavailable");
      } else {
        throw new ExecutorUnavailableError("local", executors.local.reason ?? "policy_disabled");
      }
    }
    const row: SessionRow = {
      id,
      user_id: user.id,
      title: normalizeSessionTitle(input.title ?? "", "Untitled session"),
      provider: input.provider,
      model: input.model,
      sandbox_mode: input.sandboxMode,
      sandbox_kind: sandboxKind,
      sandbox_id: null,
      sandbox_target_id: input.sandboxTargetId ?? null,
      e2b_snapshot_id: null,
      mode,
      skill_prompt: skillPrompt,
      approval_policy: input.approvalPolicy,
      status: "idle",
      thinking_level: "medium",
      cwd: workspacePathFor(user.id, id),
      ...(teamClaim ? {
        team_provision_team_id: teamClaim.teamId,
        team_provision_reservation_id: teamClaim.reservationId,
        team_provision_state: "provisional" as const,
      } : {}),
      created_at: now,
      updated_at: now,
    };
    if (teamClaim && !activeClaim()) {
      throw new Error("Team Session provision claim is no longer active");
    }
    sessionDao.create(row);
    if (sandboxKind === "connector" && typeof input.connectorUnconfined === "boolean") {
      sessionDao.setConnectorUnconfined(id, input.connectorUnconfined);
    }
    const info = rowToInfo(row);
    if (!teamClaim) this.emitUserStatus(user.id, { type: "session_created", session: info });
    return info;
  }

  listSessions(userId: string): SessionInfo[] {
    return sessionDao.listForUser(userId).map(rowToInfo);
  }

  getSessionInfo(userId: string, sessionId: string): SessionInfo | null {
    const row = sessionDao.byId(sessionId);
    if (
      !row
      || row.user_id !== userId
      || row.team_provision_state === "provisional"
    ) return null;
    return rowToInfo(row);
  }

  acknowledgeTaskResult(
    userId: string,
    taskId: string,
    expectedVersion: number,
  ): TaskResultAcknowledgeOutcome {
    const acknowledged = taskResultDao.acknowledgeDetailed({
      userId,
      taskId,
      expectedVersion,
      at: Date.now(),
    });
    if (!acknowledged) {
      const visible = orchestrationReadModel.taskDetail(userId, taskId);
      return visible?.result
        ? { ok: false, reason: "version_conflict" }
        : { ok: false, reason: "not_found" };
    }
    const { result, change } = acknowledged;
    const revision = change.revision;
    const activityRevision = change.activityRevision;
    this.markOrchestrationDirty(userId, {
      resource: "session_run",
      sessionId: change.sessionId,
      revision,
    });
    this.markOrchestrationDirty(userId, { resource: "activity", revision: activityRevision });
    return {
      ok: true,
      sessionId: change.sessionId,
      revision,
      activityRevision,
      result: {
        id: result.id,
        taskId: result.taskId,
        summary: result.summary,
        version: result.version,
        createdAt: result.createdAt,
        ...(result.acknowledgedAt === undefined ? {} : { acknowledgedAt: result.acknowledgedAt }),
      },
    };
  }

  getRuntime(userId: string, sessionId: string): AgentSessionRuntime | null {
    return this.resolveRuntime(userId, sessionId);
  }

  activateTeamSession(userId: string, sessionId: string): TeamSessionTurnRuntime {
    const runtime = this.resolveRuntime(userId, sessionId, undefined, "background-task");
    if (!runtime) throw new Error("Owned Team member Session was not found");
    return runtime;
  }

  private retireTeamSessionTurn(
    userId: string,
    sessionId: string,
    taskId: string,
    turnId: string,
    _reason: string,
  ): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (
      !runtime
      || runtime.userId !== userId
      || !runtime.ownsInternalTeamTurn(taskId, turnId)
    ) return false;
    this.cancelIdleRelease(sessionId);
    if (!runtime.retireInternalTeamTurn(taskId, turnId, _reason)) return false;
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
    return true;
  }

  teamExecutionGate(userId: string): "gated" | "draining" | undefined {
    if (this.draining) return "draining";
    return executionDenial(userId)?.kind ? "gated" : undefined;
  }

  reconcileTeamProvisioning(maxProvision = 100): TeamProvisioningReconcileStats {
    return reconcileTeamProvisioning({
      provision: (attempt) => {
        const request = attempt.reservation.request;
        const title = typeof request === "object" && request !== null && !Array.isArray(request)
          && typeof request.title === "string"
          ? request.title
          : `${attempt.teamName} · ${attempt.reservation.role}`;
        const session = this.createTeamMemberSession(
          attempt.reservation.userId,
          attempt.reservation.actorSessionId,
          title,
          {
            teamId: attempt.reservation.teamId,
            reservationId: attempt.reservation.id,
            sessionId: attempt.reservation.provisionedSessionId,
            generation: attempt.generation,
            claimToken: attempt.claimToken,
          },
        );
        return { sessionId: session.id };
      },
      retire: (userId, sessionId) => {
        if (this.deleteSession(userId, sessionId)) return;
        if (sessionDao.byId(sessionId)) throw new Error("Provisioned Team Session cleanup lost ownership");
      },
    }, {
      maxProvision,
      onError: (error, phase) => {
        const message = error instanceof Error ? error.message : String(error ?? "unknown failure");
        console.error(`[team-provisioning] ${phase}: ${message.slice(0, 500)}`);
      },
    });
  }

  createTeamMemberSession(
    userId: string,
    actorSessionId: string,
    title: string,
    claim: ReservedTeamSessionClaim,
  ): SessionInfo {
    const actor = sessionDao.byId(actorSessionId);
    const owner = userDao.byId(userId);
    if (!actor || actor.user_id !== userId || !owner) throw new Error("Owned actor Session was not found");
    if (this.draining) throw new Error("The server is restarting");
    // Inherit the actor's frozen snapshot rather than re-resolving its mode, so editing or
    // deleting the actor's skill can neither break provisioning nor diverge the member.
    let persona: Persona;
    if (actor.skill_prompt !== null) {
      persona = { mode: actor.mode, skillPrompt: actor.skill_prompt, securityMode: false };
    } else {
      const builtin = skillRegistry.resolveBuiltin(actor.mode);
      if (!builtin) throw new InvalidStoredSkillError(actor.id, actor.mode);
      persona = { mode: builtin.id, skillPrompt: null, securityMode: builtin.isSecurity };
    }
    return this.createSessionForPersona({ id: userId, email: owner.email }, {
      title: title.trim().slice(0, 120) || "Team member",
      provider: actor.provider,
      model: actor.model,
      sandboxMode: actor.sandbox_mode,
      sandboxKind: actor.sandbox_kind,
      sandboxTargetId: actor.sandbox_target_id,
      approvalPolicy: actor.approval_policy,
      ...(actor.sandbox_kind === "connector" && actor.connector_unconfined != null
        ? { connectorUnconfined: actor.connector_unconfined === 1 }
        : {}),
    }, persona, claim);
  }

  getRuntimeProfiled(userId: string, sessionId: string): RuntimeResolutionProfile {
    const profile: RuntimeResolutionProfile = {
      runtime: null,
      reused: false,
      rowLookupMs: 0,
      constructMs: 0,
      totalMs: 0,
    };
    profile.runtime = this.resolveRuntime(userId, sessionId, profile);
    return profile;
  }

  private resolveRuntime(
    userId: string,
    sessionId: string,
    profile?: RuntimeResolutionProfile,
    activation: "interactive" | "background-task" = "interactive",
  ): AgentSessionRuntime | null {
    const started = profile ? performance.now() : 0;
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      if (existing.userId !== userId) return null;
      this.cancelIdleRelease(sessionId);
      if (activation === "interactive") existing.activateInteractive();
      if (profile) {
        profile.reused = true;
        profile.totalMs = performance.now() - started;
      }
      return existing;
    }
    const rowStarted = profile ? performance.now() : 0;
    const row = sessionDao.byId(sessionId);
    if (profile) profile.rowLookupMs = performance.now() - rowStarted;
    if (!row || row.user_id !== userId || row.team_provision_state === "provisional") {
      if (profile) profile.totalMs = performance.now() - started;
      return null;
    }
    const constructStarted = profile ? performance.now() : 0;
    const teamCommands = new TeamCommandService({
      userId,
      actorSessionId: sessionId,
      provisionSession: (claimUserId, actorSessionId, title, claim) =>
        this.createTeamMemberSession(claimUserId, actorSessionId, title, claim),
      retireSession: (claimUserId, provisionedSessionId) => {
        if (this.deleteSession(claimUserId, provisionedSessionId)) return;
        if (sessionDao.byId(provisionedSessionId)) {
          throw new Error("Provisioned Team Session cleanup lost ownership");
        }
      },
      onRunnable: (changedUserId) => this.hintRuntimeTasks(changedUserId),
      onTeamChanged: (changedUserId, teamId, version) => {
        this.markOrchestrationDirty(changedUserId, { resource: "team", teamId, version });
        this.markOrchestrationDirty(changedUserId, {
          resource: "activity",
          revision: orchestrationRevisionDao.activity(changedUserId),
        });
      },
      onSessionsPublished: (changedUserId, sessionIds) => {
        for (const publishedSessionId of sessionIds) {
          const published = this.getSessionInfo(changedUserId, publishedSessionId);
          if (published) this.emitUserStatus(changedUserId, { type: "session_created", session: published });
        }
      },
    });
    const runtime = new AgentSessionRuntime(row, {
      activation,
      teamCommands,
      acquireBackgroundPermit: (rootAgentId) => this.taskPermits.acquire(rootAgentId),
      rejectBackgroundPermit: (rootAgentId) => {
        this.taskPermits.revoke(rootAgentId);
        this.taskDispatchControl?.reject(rootAgentId);
      },
      onBackgroundRunnable: () => this.taskDispatchControl?.hint(userId),
      onBackgroundTaskChanged: (taskId) => this.notifyWorkflowTaskChanged(userId, taskId),
      onWorkflowChanged: (workflow) => {
        this.notifyWorkflowChanged(workflow);
        this.workflowSchedulerControl?.hint(workflow.userId, workflow.id);
      },
    });
    if (this.draining) runtime.suspendQueuedTurnsForDrain();
    if (profile) profile.constructMs = performance.now() - constructStarted;
    runtime.onPtyIdle = () => this.releaseIfIdle(userId, sessionId);
    runtime.onBackgroundIdle = () => this.releaseAfterBackgroundAttempt(userId, sessionId, runtime);
    runtime.onBackgroundAttemptEnd = (taskId) => {
      this.taskDispatchControl?.hint(userId);
      this.notifyWorkflowTaskChanged(userId, taskId);
      this.releaseAfterBackgroundAttempt(userId, sessionId, runtime);
    };
    runtime.onWake = (ev) => {
      if (ev.type === "orchestration_invalidated") {
        const { type: _type, ...change } = ev;
        this.markOrchestrationDirty(userId, change);
      } else {
        this.emitUserStatus(userId, ev);
      }
    };
    runtime.onIsolationRequired = () => {
      if (this.runtimes.get(sessionId) !== runtime) return;
      this.cancelIdleRelease(sessionId);
      try { runtime.close(true); } catch {  }
      this.taskPermits.revoke(runtime.getRootAgentId());
      this.runtimes.delete(sessionId);
    };

    this.runtimes.set(sessionId, runtime);
    const root = agentNodeDao.rootBySession(userId, sessionId);
    const revision = root ? agentNodeDao.addressableRosterRevision(userId, root.id) : undefined;
    if (root && revision !== undefined) {
      this.markOrchestrationDirty(userId, { resource: "session_run", sessionId, revision });
      this.markOrchestrationDirty(userId, {
        resource: "activity",
        revision: orchestrationRevisionDao.activity(userId),
      });
    }
    if (profile) profile.totalMs = performance.now() - started;
    return runtime;
  }

  getSessionTimeline(
    userId: string,
    sessionId: string,
  ): { epoch: string; items: TimelineItem[]; status: SessionStatus } | null {
    const rt = this.getRuntime(userId, sessionId);
    if (!rt) return null;
    return { epoch: rt.getEpoch(), items: rt.getTimeline(), status: rt.getStatus() };
  }

  tryStartTurn(
    userId: string,
    sessionId: string,
    prompt: string,
  ): { started: true } | { error: "not-found" | "busy" } {
    if (this.draining) return { error: "busy" };
    const rt = this.getRuntime(userId, sessionId);
    if (!rt) return { error: "not-found" };
    if (rt.isBusy()) return { error: "busy" };
    try {
      const turn = rt.sendMessage(prompt);
      void turn.catch((err) => {
        console.error(`[automations] run-now turn failed:`, err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.error(`[automations] run-now turn failed:`, err instanceof Error ? err.message : err);
    }
    return { started: true };
  }

  async writeUpload(
    userId: string,
    sessionId: string,
    name: string,
    dataB64: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: "not-found" }> {
    const rt = this.getRuntime(userId, sessionId);
    if (!rt) return { ok: false, error: "not-found" };
    const data = new Uint8Array(Buffer.from(dataB64, "base64"));
    const out = await rt.writeUpload(name, data);
    return { ok: true, path: out.path };
  }

  async prepareFilePreview(userId: string, sessionId: string, filePath: string) {
    return await prepareFilePreviewOwned(userId, sessionId, filePath);
  }

  async readFilePreviewChunk(
    userId: string,
    sessionId: string,
    filePath: string,
    opts: ReadFilePreviewChunkOptions,
  ) {
    return await readFilePreviewChunkOwned(userId, sessionId, filePath, opts);
  }

  isDraining(): boolean {
    return this.draining;
  }

  setDraining(): void {
    if (this.draining) return;
    this.draining = true;
    this.workflowSchedulerControl?.stopClaiming();
    this.taskDispatchControl?.stopClaiming();
    this.taskPermits.clearOffers();
    for (const runtime of this.runtimes.values()) runtime.suspendQueuedTurnsForDrain();
    closeFilePreviewSandboxes();
  }

  async drainTurns({ waitMs, settleMs }: { waitMs: number; settleMs: number }): Promise<{ finished: number; interrupted: number }> {
    const busy = () => [...this.runtimes.values()].filter((rt) => rt.isBusy() || rt.hasLiveAgentTasks());
    const before = busy().length;
    const deadline = Date.now() + waitMs;
    while (busy().length > 0 && Date.now() < deadline) {
      await sleep(250);
    }
    const remaining = busy();
    for (const rt of remaining) {
      rt.interrupt(false, true, {
        origin: "system",
        reason: "Team Turn interrupted by server drain.",
      });
      rt.retireBackgroundTasksForDrain();
    }
    const settleDeadline = Date.now() + settleMs;
    while (busy().length > 0 && Date.now() < settleDeadline) {
      await sleep(100);
    }
    return { finished: before - remaining.length, interrupted: remaining.length };
  }

  releaseIfIdle(userId: string, sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt || rt.userId !== userId) return;
    if (rt.isBusy() || rt.hasLiveAgentTasks() || rt.hasBackgroundTasks() || rt.hasListeners() || rt.hasLivePty()) return;
    const graceMs = Math.max(0, Number(process.env.AGENT_WEB_SESSION_WARM_MS ?? 15_000) || 0);
    const maxWarm = Math.max(0, Math.floor(Number(process.env.AGENT_WEB_SESSION_WARM_MAX ?? 3) || 0));
    const globalMaxWarm = Math.max(0, Math.floor(Number(process.env.AGENT_WEB_SESSION_WARM_GLOBAL_MAX ?? 24) || 0));
    if (graceMs > 0 && maxWarm > 0 && globalMaxWarm > 0) {
      if (this.idleReleaseTimers.has(sessionId)) return;
      const warm = [...this.idleReleaseTimers.entries()]
        .filter(([, lease]) => lease.userId === userId)
        .sort((a, b) => a[1].scheduledAt - b[1].scheduledAt);
      while (warm.length >= maxWarm) {
        const [oldestId] = warm.shift()!;
        this.cancelIdleRelease(oldestId);
        this.closeRuntimeIfIdle(userId, oldestId);
      }
      const globalWarm = [...this.idleReleaseTimers.entries()]
        .sort((a, b) => a[1].scheduledAt - b[1].scheduledAt);
      while (globalWarm.length >= globalMaxWarm) {
        const [oldestId, oldest] = globalWarm.shift()!;
        this.cancelIdleRelease(oldestId);
        this.closeRuntimeIfIdle(oldest.userId, oldestId);
      }
      const timer = setTimeout(() => {
        this.idleReleaseTimers.delete(sessionId);
        this.closeRuntimeIfIdle(userId, sessionId);
      }, graceMs);
      timer.unref?.();
      this.idleReleaseTimers.set(sessionId, { userId, scheduledAt: Date.now(), timer });
      return;
    }
    this.closeRuntimeIfIdle(userId, sessionId);
  }

  private releaseAfterBackgroundAttempt(
    userId: string,
    sessionId: string,
    expected: AgentSessionRuntime,
  ): void {
    queueMicrotask(() => {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime || runtime !== expected || runtime.userId !== userId) return;
      if (
        !runtime.isInteractive()
        && !runtime.isBusy()
        && !runtime.hasLiveAgentTasks()
        && !runtime.hasListeners()
        && !runtime.hasLivePty()
      ) {
        this.cancelIdleRelease(sessionId);
        this.taskPermits.revoke(runtime.getRootAgentId());
        runtime.close();
        this.runtimes.delete(sessionId);
        this.taskDispatchControl?.hint(userId);
        return;
      }
      this.releaseIfIdle(userId, sessionId);
    });
  }

  private cancelIdleRelease(sessionId: string): void {
    const lease = this.idleReleaseTimers.get(sessionId);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.idleReleaseTimers.delete(sessionId);
  }

  private closeRuntimeIfIdle(userId: string, sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (
      !rt
      || rt.userId !== userId
      || rt.isBusy()
      || rt.hasLiveAgentTasks()
      || rt.hasBackgroundTasks()
      || rt.hasListeners()
      || rt.hasLivePty()
    ) return;
    rt.close();
    this.taskPermits.revoke(rt.getRootAgentId());
    this.runtimes.delete(sessionId);
  }

  refreshTargetRuntimes(userId: string, kind: SandboxKind, targetId: string): number {
    invalidateOwnedFilePreviewSandboxes(userId);
    let n = 0;
    for (const sessionId of [...this.runtimes.keys()]) {
      const rt = this.runtimes.get(sessionId);
      if (!rt || rt.userId !== userId) continue;
      const row = sessionDao.byId(sessionId);
      if (!row || row.sandbox_kind !== kind || row.sandbox_target_id !== targetId) continue;
      this.cancelIdleRelease(sessionId);
      this.closeRuntimeIfIdle(userId, sessionId);
      if (!this.runtimes.has(sessionId)) n++;
    }
    return n;
  }

  disposeUserRuntimes(userId: string): number {
    invalidateOwnedFilePreviewSandboxes(userId);
    let n = 0;
    for (const [sid, rt] of [...this.runtimes]) {
      if (rt.userId !== userId) continue;
      this.cancelIdleRelease(sid);
      try {
        rt.interrupt();
      } catch {
      }
      rt.close();
      this.taskPermits.revoke(rt.getRootAgentId());
      this.runtimes.delete(sid);
      n++;
    }
    return n;
  }

  private sessionLocks = new Map<string, Promise<unknown>>();
  private withSessionLock<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    const tail = next.catch(() => {});
    this.sessionLocks.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionLocks.get(sessionId) === tail) this.sessionLocks.delete(sessionId);
    });
    return next;
  }

  async rewind(
    userId: string,
    sessionId: string,
    toSeq: number,
    newText?: string,
    authEpoch?: number,
  ): Promise<{ ok: true; epoch: string } | { ok: false; reason: string }> {
    if (this.draining) return { ok: false, reason: "server is restarting" };
    return this.withSessionLock(sessionId, () => {
      if (this.draining) return { ok: false, reason: "server is restarting" } as const;
      const rt = this.getRuntime(userId, sessionId);
      if (!rt) return { ok: false, reason: "not found" } as const;
      if (agentTurnDao.list(sessionId).some((turn) =>
        turn.source === "team" && (turn.endSeq == null || turn.endSeq >= toSeq)
      )) return { ok: false, reason: "team-history" } as const;
      const res = rt.rewind(toSeq, authEpoch);
      if (!res.ok) return { ok: false, reason: res.reason } as const;
      rt.close();
      this.taskPermits.revoke(rt.getRootAgentId());
      this.runtimes.delete(sessionId);
      const fresh = this.getRuntime(userId, sessionId);
      if (!fresh) return { ok: false, reason: "could not rebuild session" } as const;
      if (newText && newText.trim()) {
        try {
          const turn = fresh.sendMessage(newText, undefined, undefined, authEpoch);
          void turn.catch(() => {});
        } catch {
        }
      }
      this.emitUserStatus(userId, { type: "session_rewound", sessionId });
      return { ok: true, epoch: fresh.getEpoch() } as const;
    });
  }

  async setSandbox(
    userId: string,
    sessionId: string,
    kind: SandboxKind,
    targetId?: string | null,
    authEpoch?: number,
  ): Promise<{ ok: true; epoch: string } | { ok: false; reason: string }> {
    if (this.draining) return { ok: false, reason: "server is restarting" };
    const executors = currentExecutorAvailability();
    if (kind === "local" && !executors.local.available) return { ok: false, reason: "local-disabled" };
    if (kind === "e2b" && !executors.e2b.available) {
      return {
        ok: false,
        reason: executors.e2b.reason === "capacity_unavailable" ? "e2b-capacity-unavailable" : "e2b-unavailable",
      };
    }
    if (kind === "connector" && (!targetId || !connectorDao.byId(userId, targetId))) return { ok: false, reason: "not found" };
    if (kind === "ssh" && (!targetId || !sshTargetDao.byId(userId, targetId))) return { ok: false, reason: "not found" };
    return this.withSessionLock(sessionId, () => {
      if (this.draining) return { ok: false, reason: "server is restarting" } as const;
      const rt = this.getRuntime(userId, sessionId);
      if (!rt) return { ok: false, reason: "not found" } as const;
      if (rt.isBusy() || rt.hasOpenAgentTasks()) return { ok: false, reason: "busy" } as const;
      runInImmediateTransaction(() => {
        assertAuthEpochInWriterTransaction(userId, authEpoch);
        sessionDao.setSandboxBackend(sessionId, kind, targetId ?? null);
      });
      rt.close();
      this.taskPermits.revoke(rt.getRootAgentId());
      this.runtimes.delete(sessionId);
      const fresh = this.getRuntime(userId, sessionId);
      if (!fresh) return { ok: false, reason: "could not rebuild session" } as const;
      logAudit("session_set_sandbox", { userId, data: { sessionId, kind, targetId: targetId ?? null } });
      this.emitUserStatus(userId, { type: "sandbox_changed", sessionId, kind, targetId: targetId ?? null });
      return { ok: true, epoch: fresh.getEpoch() } as const;
    });
  }

  async forkSession(
    userId: string,
    srcId: string,
    fromSeq: number,
  ): Promise<{ ok: true; info: SessionInfo } | { ok: false; reason: string }> {
    return this.withSessionLock(srcId, () => {
      const src = sessionDao.byId(srcId);
      if (!src || src.user_id !== userId) return { ok: false, reason: "not found" } as const;
      const live = this.runtimes.get(srcId);
      if (live && (live.isBusy() || live.hasOpenAgentTasks())) {
        return { ok: false, reason: "busy" } as const;
      }
      if (agentTurnDao.list(srcId).some((turn) =>
        turn.source === "team" && (turn.startSeq == null || turn.startSeq <= fromSeq)
      )) return { ok: false, reason: "not-forkable" } as const;
      if (runtimeTaskDao.ownedThroughTimelineSeq(userId, srcId, fromSeq)) {
        return { ok: false, reason: "not-forkable" } as const;
      }
      if (timelineDao.kindAt(srcId, fromSeq) !== "user") return { ok: false, reason: "not-forkable" } as const;
      if (fromSeq <= timelineDao.latestCompactionSeq(srcId)) return { ok: false, reason: "compacted" } as const;
      const cut = timelineDao.msgCutAt(srcId, fromSeq);
      if (cut == null || !Number.isInteger(cut) || cut < 0) return { ok: false, reason: "too-old" } as const;

      const newId = "s_" + crypto.randomUUID();
      const now = Date.now();
      const cwd = workspacePathFor(userId, newId);
      const row: SessionRow = {
        ...src,
        id: newId,
        title: forkTitle(src.title),
        status: "idle",
        sandbox_id: null,
        e2b_snapshot_id: null,
        cwd,
        created_at: now,
        updated_at: now,
      };
      runInTransaction(() => {
        sessionDao.create(row);
        sessionDao.setThinkingLevel(newId, src.thinking_level ?? "medium");
        timelineDao.copyPrefixInto(srcId, newId, fromSeq);
        agentTurnDao.copyPrefixInto(srcId, newId, fromSeq, now);
        messageDao.replaceAll(newId, messageDao.list(srcId).slice(0, cut));
        for (const c of compactionDao.listForSession(srcId)) {
          if (c.seq > fromSeq) continue;
          const newCid = "cmp_" + crypto.randomUUID();
          compactionDao.create({ ...c, id: newCid, session_id: newId });
          timelineDao.remapCompactionId(newId, c.seq, newCid);
        }
      });
      if (src.sandbox_kind === "local") {
        void copyWorkspaceBestEffort(workspacePathFor(userId, srcId), cwd).catch((e) =>
          logAudit("session_fork_workspace_skipped", {
            level: "warn",
            userId,
            sessionId: newId,
            data: { reason: errorMessage(e) },
          }),
        );
      }
      const info = this.getSessionInfo(userId, newId);
      if (!info) return { ok: false, reason: "could not create fork" } as const;
      return { ok: true, info } as const;
    });
  }

  renameSession(userId: string, sessionId: string, title: string): SessionInfo | null {
    const row = sessionDao.byId(sessionId);
    if (!row || row.user_id !== userId) return null;
    const clean = normalizeSessionTitle(title);
    if (!clean) return null;
    const renamed = sessionDao.setTitle(sessionId, clean);
    if (!renamed) return null;
    this.markOrchestrationDirty(userId, {
      resource: "activity",
      revision: renamed.activityRevision,
    });
    this.emitUserStatus(userId, { type: "session_renamed", sessionId, title: clean });
    return rowToInfo({ ...row, title: clean });
  }

  setThinkingLevel(userId: string, sessionId: string, level: ThinkingLevel): SessionInfo | null {
    const row = sessionDao.byId(sessionId);
    if (!row || row.user_id !== userId) return null;
    sessionDao.setThinkingLevel(sessionId, level);
    return rowToInfo({ ...row, thinking_level: level });
  }

  setModel(userId: string, sessionId: string, provider: string, model: string): SessionInfo | null {
    const row = sessionDao.byId(sessionId);
    if (!row || row.user_id !== userId) return null;
    const providersWithKeys = keyDao.list(userId).map((k) => k.provider);
    const available = listModelsForProviders(providersWithKeys);
    if (!available.some((m) => m.provider === provider && m.id === model)) return null;
    sessionDao.setModel(sessionId, provider, model);
    return rowToInfo({ ...row, provider, model });
  }

  setApprovalPolicy(userId: string, sessionId: string, policy: ApprovalPolicy): SessionInfo | null {
    const row = sessionDao.byId(sessionId);
    if (!row || row.user_id !== userId) return null;
    sessionDao.setApprovalPolicy(sessionId, policy);
    if (policy === "untrusted" && row.approval_policy !== "untrusted") sessionDao.setApprovedTools(sessionId, []);
    return rowToInfo({ ...row, approval_policy: policy });
  }

  deleteSession(userId: string, sessionId: string): boolean {
    const row = sessionDao.byId(sessionId);
    if (!row || row.user_id !== userId) return false;
    invalidateOwnedFilePreviewSandboxes(userId, sessionId);
    let afterTaskId = "";
    for (;;) {
      const attempts = teamTaskDao.activeTurnsAffectedBySessionDeletion(
        userId,
        sessionId,
        100,
        afterTaskId,
      );
      for (const attempt of attempts) {
        const affected = this.runtimes.get(attempt.sessionId);
        if (!affected || affected.userId !== userId) continue;
        const reason = attempt.ownerDeleted
          ? "Team Turn cancelled because the Team owner Session was deleted."
          : "Team Turn cancelled because a required Session was deleted.";
        if (!affected.retireInternalTeamTurn(attempt.taskId, attempt.turnId, {
          reason,
          outcomeStatus: "cancelled",
          ...(attempt.ownerDeleted ? { origin: "owner_session_deleted" as const } : {}),
        })) continue;
        this.cancelIdleRelease(attempt.sessionId);
        if (this.runtimes.get(attempt.sessionId) === affected) this.runtimes.delete(attempt.sessionId);
      }
      if (attempts.length < 100) break;
      afterTaskId = attempts.at(-1)!.taskId;
    }
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      this.cancelIdleRelease(sessionId);
      rt.close();
      this.taskPermits.revoke(rt.getRootAgentId());
      this.runtimes.delete(sessionId);
    }
    const invalidations = sessionDao.delete(sessionId);
    for (const invalidation of invalidations.runs) {
      this.taskPermits.revoke(invalidation.rootAgentId);
    }
    for (const task of invalidations.liveTasks) {
      this.taskPermits.revoke(task.rootAgentId);
      const execution = this.runtimes.get(task.executionSessionId);
      if (!execution || execution.userId !== task.userId) continue;
      this.cancelIdleRelease(task.executionSessionId);
      try {
        execution.interruptDeletedOrchestrationTask(task.rootAgentId, task.taskId);
      } catch (error) {
        logAudit("session_delete_task_interrupt_failed", {
          level: "warn",
          userId: task.userId,
          sessionId: task.executionSessionId,
          data: { taskId: task.taskId, error: errorMessage(error) },
        });
      }
    }
    this.taskDispatchControl?.hint(userId);
    this.emitUserStatus(userId, { type: "session_deleted", sessionId });
    for (const invalidation of invalidations.runs) {
      this.markOrchestrationDirty(invalidation.userId, {
        resource: "session_run",
        sessionId: invalidation.sessionId,
        revision: invalidation.revision,
      });
    }
    for (const invalidation of invalidations.activities) {
      this.markOrchestrationDirty(invalidation.userId, {
        resource: "activity",
        revision: invalidation.revision,
      });
    }
    for (const invalidation of invalidations.workflows) {
      this.markOrchestrationDirty(invalidation.userId, {
        resource: "workflow",
        workflowId: invalidation.workflowId,
        version: invalidation.version,
      });
    }
    for (const invalidation of invalidations.teams) {
      this.markOrchestrationDirty(invalidation.userId, {
        resource: "team",
        teamId: invalidation.teamId,
        version: invalidation.version,
      });
    }
    return true;
  }

  invalidateFilePreviewSandboxes(userId: string, sessionId?: string): number {
    return invalidateOwnedFilePreviewSandboxes(userId, sessionId);
  }
}

export const sessionManager = new SessionManager();

type SessionRuntimeClient = Pick<
  SessionManager,
  | "createSession"
  | "getExecutorAvailability"
  | "listSessions"
  | "getSessionInfo"
  | "acknowledgeTaskResult"
  | "getRuntime"
  | "getRuntimeProfiled"
  | "getSessionTimeline"
  | "tryStartTurn"
  | "writeUpload"
  | "prepareFilePreview"
  | "readFilePreviewChunk"
  | "isDraining"
  | "releaseIfIdle"
  | "refreshTargetRuntimes"
  | "disposeUserRuntimes"
  | "invalidateFilePreviewSandboxes"
  | "subscribeUserStatus"
  | "liveSessionStatuses"
  | "liveSessionActivities"
  | "setThinkingLevel"
  | "setApprovalPolicy"
  | "setModel"
  | "rewind"
  | "setSandbox"
  | "renameSession"
  | "forkSession"
  | "deleteSession"
>;

type CM = typeof connectorManager;
export interface ConnectorRuntimeClient {
  connectorList: CM["list"];
  connectorTelemetry: CM["telemetry"];
  connectorCreatePairing: CM["createPairing"];
  connectorRedeemPairing: CM["redeemPairing"];
  connectorCreateToken: CM["createToken"];
  connectorDelete: CM["delete"];
  connectorTestExec(connectorId: string, params: ConnectorExecParams): Promise<Awaited<ReturnType<CM["exec"]>>>;
}

const connectorRuntimeClient: ConnectorRuntimeClient = {
  connectorList: (userId) => connectorManager.list(userId),
  connectorTelemetry: (connectorId) => connectorManager.telemetry(connectorId),
  connectorCreatePairing: (userId, name, workspaceRoot) => connectorManager.createPairing(userId, name, workspaceRoot),
  connectorRedeemPairing: (code, opts) => connectorManager.redeemPairing(code, opts),
  connectorCreateToken: (userId, name, workspaceRoot) => connectorManager.createToken(userId, name, workspaceRoot),
  connectorDelete: (userId, id) => {
    connectorManager.delete(userId, id);
    sessionManager.invalidateFilePreviewSandboxes(userId);
  },
  connectorTestExec: (connectorId, params) => connectorManager.exec(connectorId, params),
};

export type RuntimeClient = SessionRuntimeClient & ConnectorRuntimeClient;
export const runtimeClient: RuntimeClient = Object.assign(sessionManager, connectorRuntimeClient);
