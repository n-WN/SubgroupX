import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { errorMessage, classifyError } from "../foundation/errors.ts";
import { readFileSync } from "node:fs";
import { executionDenial, runtimeExecutionDenial } from "../identity/access-gate.ts";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { shouldCompact, generateSummary, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { countText, countTextHard, countMessage, countMessageHard, warmupTokenizer } from "./token-count.ts";
import { computeContextUsage, compactionReserveTokens as reserveTokensFor, compactTriggerAt as triggerAtFor, seedContextTokensFromTranscript, type ContextUsage } from "./context-accounting.ts";
import {
  buildExtractiveCompactionSummary,
  COMPACTION_SUMMARY_INPUT_CTX,
  COMPACTION_SUMMARY_OUTPUT_CTX,
  COMPACTION_SUMMARY_RETRY_INPUT_CTX,
  COMPACTION_SUMMARY_RETRY_TIMEOUT_MS,
  COMPACTION_SUMMARY_TIMEOUT_MS,
  CompactionSummaryAbortedError,
  CompactionSummaryTimeoutError,
  runBoundedCompactionSummary,
  selectCompactionSummaryInput,
  type SummaryInputSelection,
} from "./compaction-summary.ts";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai";
import type {
  ServerEvent,
  WireAgentEvent,
  TimelineItem,
  AssistantBlock,
  PermissionDecision,
  PermissionRequestPayload,
  AgentTurnStatus,
  SessionStatus,
  SessionMode,
  ShellResult,
  ToolCallStatus,
  ToolKind,
  PendingMessage,
  PendingMutationResult,
} from "../../../shared/src/protocol.ts";
import { TEAM_PROVIDER_MIN_OUTPUT_TOKENS } from "../../../shared/src/orchestration.ts";
import type { AgentNode, OrchestrationJson, Workflow } from "../../../shared/src/orchestration.ts";
import {
  agentNodeDao,
  agentMessageDao,
  connectorDao,
  sessionDao,
  agentTurnDao,
  timelineDao,
  messageDao,
  userDao,
  sshTargetDao,
  requestCaptureDao,
  compactionDao,
  pendingMessageDao,
  recapJobDao,
  normalizeSessionTitle,
  runInImmediateTransaction,
  runInTransaction,
  runtimeTaskDao,
  joinedTaskProgressDao,
  teamTaskDao,
  teamDao,
  taskResultDao,
  taskResultDeliveryDao,
  teamTurnOutcomeDao,
  orchestrationRevisionDao,
  type OrchestrationRevisionChange,
  TASK_RESULT_ARTIFACTS_MAX_BYTES,
  type SessionRow,
} from "../persistence/index.ts";
import { packCapture, buildResponseMeta, type ResponseMeta } from "./capture.ts";
import { resolveSshPrivateKey } from "./ssh-unlock.ts";
import type { SSHTarget } from "./ssh-sandbox.ts";
import { createSandbox, type Sandbox, type PtyHandle } from "./sandbox.ts";
import { PtyInputQueue } from "./pty-input-queue.ts";
import {
  createTools,
  DELEGATION_TOOLS,
  APPROVAL_GATED_TOOLS,
  describeToolCall,
  toolKind,
  type AgentOrchestrationRunner,
  type SubagentRunner,
  type WorkflowRunner,
} from "./tools.ts";
import { builtinToolSource, mcpToolSource, composeTools, type ToolSource } from "./tool-sources.ts";
import { resolveModel, apiKeyResolver, effectiveThinkingLevel, MOCK_PROVIDER } from "./providers.ts";
import { ORCAROUTER_PROVIDER } from "./orcarouter.ts";
import { markOrcaNeedsReauth, orcaCredentialGeneration } from "./orcarouter-auth.ts";
import { userMemoryPromptBlock } from "./memory-dreaming.ts";
import { mcpServersFromEnv, CAPTURE_RAW, publicOriginFor } from "../config.ts";
import { errorKind, logAudit } from "../observability/audit-log.ts";
import { recordTurnPerf } from "../status/perf.ts";
import { modelRetryBackoffMs, modelRetryLimit } from "./model-retry.ts";
import { ProviderStreamTiming } from "./provider-stream-timing.ts";
import { recoverInterruptedSession, type TeamTurnRetirement } from "./recovery.ts";
import { WorkspaceWriteLease } from "../orchestration/workspace-lease.ts";
import { extractEditResult } from "./edit-file-tool.ts";
import { AgentSupervisor, type AgentTaskHandle } from "../orchestration/agent-supervisor.ts";
import { WorkflowLaunchService } from "../orchestration/workflow-launch.ts";
import type {
  TeamInternalTurnInput,
  TeamInternalTurnResult,
} from "../orchestration/team-turn-executor.ts";
import {
  convertTeamMessageToLlm,
  convertTeamMessagesToLlm,
  isAgentPromptBoundary,
  validateStoredTeamMessages,
  type TeamAssignmentMessage,
} from "../orchestration/team-message.ts";
import {
  createPiChildWorkerFactory,
  PI_CHILD_SEED_MAX_BYTES,
  PI_CHILD_SEED_MAX_MESSAGE_BYTES,
  PI_CHILD_SEED_MAX_MESSAGES,
  projectPiChildTranscript,
  type PiChildContextMode,
} from "../orchestration/pi-child-worker.ts";
import {
  AgentContextDigestRenderer,
  stableAgentAliases,
} from "../orchestration/context-digest.ts";
import {
  createTeamTools,
  TEAM_TOOL_NAMES,
  type TeamToolCommands,
  type TeamToolParent,
} from "../orchestration/team-tools.ts";
import {
  RECAP_CONTRACT_VERSION,
  buildRecapSnapshot,
  decodeRecapJob,
  generateRecapText,
  type PendingRecap,
  type RecapActivity,
  type RecapSnapshotV1,
} from "./recap.ts";
import {
  AUTH_EPOCH_REVOKED_MESSAGE,
  AuthEpochRevokedError,
  RuntimeMutationRejectedError,
  assertAuthEpochInWriterTransaction,
} from "./auth-epoch.ts";

type PendingMutationDenial = Extract<PendingMutationResult, { ok: false }>;
type PendingMutationTxnOutcome<T> =
  | { state: "noop" }
  | { state: "denied"; result: PendingMutationDenial }
  | { state: "changed"; value: T; rebuildSteering?: boolean };
type PendingMutationOutcome<T> = PendingMutationTxnOutcome<T> | { state: "failed"; result: PendingMutationDenial };

const PENDING_MUTATION_FAILED_MESSAGE = "The pending change failed. Server truth was restored.";

function samePendingSnapshot(left: readonly PendingMessage[], right: readonly PendingMessage[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.id === other.id && item.kind === other.kind &&
      item.text === other.text && item.ts === other.ts && item.ord === other.ord;
  });
}

const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>(["success", "error", "denied"]);

function loadPrompt(name: string): string {
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
}

function rawErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  return raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw;
}

const ERROR_UI_MESSAGES: Record<string, string> = {
  rate_limit: "The model is rate-limited right now (429). Wait a few seconds and try again.",
  auth: "The provider rejected the request (auth/permission). Check this provider's API key in Settings.",
  timeout: "The model request timed out. The provider may be slow — please try again.",
  context: "This conversation exceeded the model's context window. Start a new session or shorten your message.",
  network: "Could not reach the model provider (network error). Check connectivity and try again.",
  cyber_policy: "The model declined this request under its cybersecurity policy. Try rephrasing it and sending again.",
  provider_config: "This model is not enabled by the provider configuration. Choose another model or ask the operator to enable it.",
  quota: "The provider account has no available quota. Check billing or choose another provider.",
  request: "The provider rejected this model request. Check the model configuration or change the request.",
  server: "The model provider returned a server error (5xx). It's likely transient — try again shortly.",
};

const SYSTEM_PROMPT = loadPrompt("coding");
const SUBAGENT_PROMPT = loadPrompt("subagent");
const WORKFLOW_CONTROLLER_PROMPT = loadPrompt("workflow-controller");
const PENTEST_PROMPT = loadPrompt("pentest");
const EXPLOIT_PROMPT = loadPrompt("exploit");
const BOLD_PROMPT = loadPrompt("bold");

let CTF_CONTRACT = "";
try {
  CTF_CONTRACT = loadPrompt("ctf-contract");
} catch {
  CTF_CONTRACT = "";
}

function systemPromptFor(mode: SessionMode): string {
  if (mode === "pentest") return CTF_CONTRACT ? `${PENTEST_PROMPT}\n\n---\n\n${CTF_CONTRACT}` : PENTEST_PROMPT;
  if (mode === "exploit") return CTF_CONTRACT ? `${EXPLOIT_PROMPT}\n\n---\n\n${CTF_CONTRACT}` : EXPLOIT_PROMPT;
  if (mode === "bold") return BOLD_PROMPT;
  return SYSTEM_PROMPT;
}

const SELF_TRAJECTORY_PROMPT = loadPrompt("self-trajectory");
const WORKSPACE_LINKS_PROMPT = loadPrompt("workspace-links");
const DIAGRAMS_PROMPT = loadPrompt("diagrams");
const AGENT_ROSTER_PROMPT = loadPrompt("agent-roster");

function composeSystemPrompt(mode: SessionMode, trajectoryUrl: string | null): string {
  const base = `${systemPromptFor(mode)}\n\n---\n\n${WORKSPACE_LINKS_PROMPT}\n\n---\n\n${DIAGRAMS_PROMPT}\n\n---\n\n${AGENT_ROSTER_PROMPT}`;
  if (!trajectoryUrl) return base;
  return `${base}\n\n---\n\n${SELF_TRAJECTORY_PROMPT.replaceAll("{{TRAJECTORY_URL}}", trajectoryUrl)}`;
}

function selfTrajectoryUrl(sessionId: string): string | null {
  const token = sessionDao.selfToken(sessionId);
  return token ? `${publicOriginFor("https", undefined)}/api/self/${token}/trajectory` : null;
}

const TIME_OPEN = "\n\n⁠<oiia-now>";
const TIME_CLOSE = "</oiia-now>⁠";
const TIME_RE = /\n\n⁠<(?:o11n|oiia)-now>[\s\S]*?<\/(?:o11n|oiia)-now>⁠$/;
function timeBlock(): string {
  const d = new Date();
  return TIME_OPEN + d.toISOString() + " (" + d.toLocaleString("en-US", { timeZone: "UTC" }) + " UTC)" + TIME_CLOSE;
}
function stripTime(s: string): string {
  return s.replace(TIME_RE, "");
}

function awaitSetupOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve({ completed: false });
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve({ completed: true, value });
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const CANVAS_STATE_MAX = 8000;
function canvasBlock(canvasState?: string): string {
  const s = (typeof canvasState === "string" ? canvasState : "").replace(/\r\n?/g, "\n").trim();
  if (!s) return "";
  const clipped = s.length > CANVAS_STATE_MAX ? s.slice(0, CANVAS_STATE_MAX) + "\n… (truncated)" : s;
  const safe = clipped.replace(/<(\/?)(canvas-interaction)/gi, "&lt;$1$2");
  return `<canvas-interaction>\n${safe}\n</canvas-interaction>\n\n`;
}

function envNonNegativeMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 16) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}\n…[truncated]`;
}

function collectTeamArtifacts(items: TimelineItem[]): OrchestrationJson {
  const artifacts: Array<{ path: string; tool: string }> = [];
  let encodedBytes = 2;
  for (const item of items) {
    if (artifacts.length >= 128) break;
    if (
      item.kind !== "tool"
      || item.status !== "success"
      || !item.path
    ) continue;
    const artifact = { path: item.path, tool: item.name };
    const artifactBytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
    const nextBytes = encodedBytes + artifactBytes + (artifacts.length > 0 ? 1 : 0);
    if (nextBytes > TASK_RESULT_ARTIFACTS_MAX_BYTES) continue;
    artifacts.push(artifact);
    encodedBytes = nextBytes;
  }
  return artifacts;
}

const COMPACTION_SUMMARY_PREFIX = "[Context note]";

type PendingPermissionDecision = PermissionDecision | "turn_aborted";

interface PendingPermission {
  resolve: (decision: PendingPermissionDecision) => void;
  request: PermissionRequestPayload;
}

const UPDATE_COALESCE_MS = 40;

const LOAD_SAMPLE_MS = 3000;

const DEFAULT_RECAP_IDLE_MS = 270_000;

const RECAP_IDLE_MS = envNonNegativeMs("AGENT_WEB_RECAP_IDLE_MS", DEFAULT_RECAP_IDLE_MS);
const RECAP_COMMIT_RETRY_MS = 30_000;

const PTY_RING_MAX_BYTES = 1_000_000;
const PTY_GRACE_MS = Number(process.env.AGENT_WEB_PTY_GRACE_MS || 180_000);

export interface AgentSessionRuntimeOptions {
  activation?: "interactive" | "background-task";
  acquireBackgroundPermit?: (rootAgentId: string) => (() => void) | undefined;
  rejectBackgroundPermit?: (rootAgentId: string) => void;
  onBackgroundRunnable?: (rootAgentId: string) => void;
  onBackgroundTaskChanged?: (taskId: string) => void;
  onWorkflowChanged?: (workflow: Workflow) => void;
  teamCommands?: TeamToolCommands;
}

export class AgentSessionRuntime {
  readonly sessionId: string;
  readonly userId: string;
  private row: SessionRow;
  private agent: Agent;
  private sandbox: Sandbox;
  private model: Model<any>;
  private readonly getKey: (provider: string) => string | undefined;
  private readonly systemPrompt: string;
  private effectiveSystemPrompt = "";
  private readonly contextDigestRenderer = new AgentContextDigestRenderer();
  private readonly rootAgentId: string;
  private interactiveActivation: boolean;
  private readonly runtimeOptions: AgentSessionRuntimeOptions;
  private agentSupervisor: AgentSupervisor | null = null;
  private lastContextTokens = 0;
  private compactionInFlight = false;
  private idleCompaction: Promise<void> | null = null;
  private previousSummary: string | undefined;
  private readonly epoch = crypto.randomUUID();
  private wireSeq = 0;
  private timelineVersion = 0;
  private pendingUserMsgCut: number | null = null;
  private pendingUserItem: TimelineItem | null = null;
  private overflowRetryAttempted = false;
  private overflowRecoveryPending = false;
  private modelRetries = 0;
  private retryPending = false;
  private lastModelRetryKind: string | null = null;
  private modelRetryRecoveryLogged = false;
  private pendingUpdate: WireAgentEvent | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private resultAckDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private pty: PtyHandle | null = null;
  private ptyClient: { onData: (chunk: Uint8Array) => void; onExit: (code: number | null) => void } | null = null;
  private ptyRing: Uint8Array[] = [];
  private ptyRingBytes = 0;
  private ptyGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyGen = 0;
  private ptyViewer = 0;
  private ptyViewerSeq = 0;
  private ptyOpening = false;
  private ptyInput: PtyInputQueue | null = null;
  onPtyIdle: (() => void) | null = null;
  onBackgroundIdle: (() => void) | null = null;
  onBackgroundAttemptEnd: ((taskId: string) => void) | null = null;
  onWake: ((ev: ServerEvent) => void) | null = null;
  onIsolationRequired: (() => void) | null = null;
  private pendingMutationFaulted = false;
  private closed = false;
  private turnAbort: AbortController | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadStopped = true;
  private timelineSeq: number;
  private status: SessionStatus = "idle";
  private statusFeedState: SessionStatus = "idle";
  private backgroundOutcomeAtForegroundEnd: "done" | "error" | null = null;
  private readonly workspaceWriteLease = new WorkspaceWriteLease();
  private recapTimer: ReturnType<typeof setTimeout> | null = null;
  private recapLastUserText = "";
  private recapLastAssistantText = "";
  private recapActivity: RecapActivity[] = [];
  private recapTurnCompleted = false;
  private recapTurnId: string | null = null;
  private pendingRecap: PendingRecap | null = null;

  private listeners = new Set<(ev: ServerEvent) => void>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private sessionApproved = new Set<string>();
  private deniedCalls = new Set<string>();

  private toolItems = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  private timelineCache: TimelineItem[] | null = null;
  private timelineCacheIndex = new Map<number, number>();
  private toolStartedAt = new Map<string, number>();
  private toolArgumentsStartedAt = new Map<string, number>();
  private toolArgumentsReadyAt = new Map<string, number>();
  private toolDispatchedAt = new Map<string, number>();
  private proposedToolCalls = new Map<string, {
    name: string;
    toolKind: ToolKind;
    path?: string;
    arguments: Record<string, unknown>;
    ts: number;
  }>();
  private modelRoundOrdinal = 0;
  private modelRoundStartedAt: number | null = null;
  private providerStreamTiming = new ProviderStreamTiming();
  private queuedDrainScheduled = false;
  private queuedDrainRunning = false;
  private queuedDrainSuspended = false;
  private currentTurnFailed = false;
  private turnAcceptingSteer = false;

  constructor(row: SessionRow, options: AgentSessionRuntimeOptions = {}) {
    if (row.status === "running" || agentTurnDao.latestInProgress(row.id)) recoverInterruptedSession(row.id);
    this.row = row;
    this.runtimeOptions = options;
    this.interactiveActivation = options.activation !== "background-task";
    this.sessionId = row.id;
    this.userId = row.user_id;
    if (row.approved_tools) {
      try {
        const names = JSON.parse(row.approved_tools);
        if (Array.isArray(names)) for (const n of names) if (typeof n === "string") this.sessionApproved.add(n);
      } catch {
      }
    }
    const owner = userDao.byId(row.user_id);
    let sshTarget: SSHTarget | undefined;
    let sshUnconfined = false;
    if (row.sandbox_kind === "ssh") {
      const t = row.sandbox_target_id
        ? sshTargetDao.byId(row.user_id, row.sandbox_target_id)
        : sshTargetDao.listForUser(row.user_id)[0];
      if (t) {
        sshUnconfined = row.sandbox_mode === "danger-full-access" && Boolean(t.unconfined);
        sshTarget = {
          host: t.host,
          port: t.port,
          username: t.username,
          privateKey: () => resolveSshPrivateKey(row.user_id, t),
          hostFingerprint: t.host_fp,
          onFingerprint: (fp) => sshTargetDao.setFingerprint(t.id, fp),
        };
      }
    }
    let connectorTarget: { id: string; workspaceRoot: string; unconfined?: boolean } | undefined;
    if (row.sandbox_kind === "connector" && row.sandbox_target_id) {
      const connector = connectorDao.byId(row.user_id, row.sandbox_target_id);
      const override = row.connector_unconfined;
      const wantUnconfined = connector ? (override == null ? Boolean(connector.unconfined) : override === 1) : false;
      connectorTarget = {
        id: row.sandbox_target_id,
        workspaceRoot: connector?.workspace_root ?? "connector-deleted",
        unconfined: row.sandbox_mode === "danger-full-access" && wantUnconfined,
      };
    }
    this.sandbox = createSandbox(row.user_id, row.id, row.sandbox_mode, {
      kind: row.sandbox_kind,
      sandboxId: row.sandbox_id,
      onSandboxId: (id) => sessionDao.setSandboxId(row.id, id),
      proxyUrl: owner?.proxy_url || owner?.jump_server || null,
      sshTarget,
      sshUnconfined,
      connectorTarget,
      onConnecting: (connecting) => this.emit({ type: "sandbox_connecting", sessionId: this.sessionId, connecting }),
      snapshotId: row.e2b_snapshot_id,
      onSnapshotId: (sid) => sessionDao.setSnapshotId(row.id, sid),
    });
    this.timelineSeq = timelineDao.maxSeq(row.id);
    this.status = sessionDao.byId(row.id)?.status ?? (row.status === "running" ? "idle" : row.status);
    this.statusFeedState = this.status;
    this.rootAgentId = this.ensureSessionAgentRoot();

    const model = resolveModel(row.provider, row.model);
    this.model = model;
    const subagentRunner: SubagentRunner = (id, task, signal) => this.runSubagent(id, task, signal);
    const agentRunner = this.createAgentOrchestrationRunner();
    const workflowRunner = this.createWorkflowRunner();
    const builtinTools = createTools(
      this.sandbox,
      subagentRunner,
      this.workspaceWriteLease,
      agentRunner,
      workflowRunner,
    );
    const priorMessages = validateStoredTeamMessages(messageDao.list(row.id));
    const priorLlmMessages = convertTeamMessagesToLlm(priorMessages);
    this.lastContextTokens = seedContextTokensFromTranscript(priorLlmMessages, COMPACTION_SUMMARY_PREFIX);
    warmupTokenizer();

    const getKey = apiKeyResolver(row.user_id);
    this.getKey = getKey;

    this.systemPrompt = composeSystemPrompt(row.mode, selfTrajectoryUrl(row.id));
    this.effectiveSystemPrompt = this.systemPrompt;

    this.agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model,
        thinkingLevel: effectiveThinkingLevel(model, row.thinking_level),
        tools: builtinTools,
        messages: priorMessages,
      },
      sessionId: row.id,
      getApiKey: (provider) => getKey(provider),
      streamFn: (activeModel, context, options) => this.streamWithAgentContext(activeModel, context, options),
      convertToLlm: (messages) => convertTeamMessagesToLlm(messages),
      beforeToolCall: (ctx, signal) => this.handleBeforeToolCall(ctx, signal),
      onPayload: (payload: unknown): undefined => {
        const now = Date.now();
        this.providerStreamTiming.markRequestStarted(now);
        if (CAPTURE_RAW) this.pendingCapture = { request: payload, requestTs: now };
        return undefined;
      },
      onResponse: (response: { status: number; headers: Record<string, string> }): void => {
        this.providerStreamTiming.markHeaders(Date.now(), response.status);
        if (CAPTURE_RAW && this.pendingCapture) {
          this.pendingCapture.responseMeta = buildResponseMeta(response.status, response.headers);
        }
      },
    });

    this.agent.subscribe((event, signal) => this.onAgentEvent(event, signal));

    const childWorkerFactory = createPiChildWorkerFactory({
      sandbox: this.sandbox,
      workspaceWriteLease: this.workspaceWriteLease,
      model: (input) => {
        if (!input.agent.provider || !input.agent.model) {
          throw new Error("Child Agent is missing its pinned provider/model provenance");
        }
        return resolveModel(input.agent.provider, input.agent.model);
      },
      systemPrompt: `${SUBAGENT_PROMPT}\n\n---\n\n${DIAGRAMS_PROMPT}\n\n---\n\n${AGENT_ROSTER_PROMPT}`,
      workflowControllerPrompt: WORKFLOW_CONTROLLER_PROMPT,
      getApiKey: (provider) => this.getKey(provider),
      thinkingLevel: (input) => {
        if (!input.agent.provider || !input.agent.model) return "off";
        return resolveModel(input.agent.provider, input.agent.model).reasoning
          ? input.agent.thinkingLevel ?? "medium"
          : "off";
      },
      contextSeed: (input) => this.childContextSeed(
        input.agent.parentAgentId,
        input.agent.provider,
        input.agent.model,
        input.mode,
        input.limits,
      ),
      tools: (input) => createTools(
        this.sandbox,
        undefined,
        this.workspaceWriteLease,
        input.agent.purpose === "addressable"
          ? this.createAgentOrchestrationRunner(input.agent.id)
          : undefined,
      ),
      prepareStreamContext: async (context) => {
        const base = context.systemPrompt ?? `${SUBAGENT_PROMPT}\n\n---\n\n${AGENT_ROSTER_PROMPT}`;
        const systemPrompt = await this.promptWithAgentRoster(base);
        return { ...context, systemPrompt };
      },
      onResultAcknowledged: (changes) => this.publishOrchestrationChanges(changes),
      onWorkflowMutation: (workflow) =>
        this.runtimeOptions.onWorkflowChanged?.(workflow),
      workflowMaxTreeAgents: () => this.requireAgentSupervisor().limits.maxTreeAgents,
      streamFn: streamSimple,
    });
    this.agentSupervisor = new AgentSupervisor({
      userId: this.userId,
      sessionId: this.sessionId,
      rootAgentId: this.rootAgentId,
      workerFactory: childWorkerFactory,
      executionGate: () => this.queuedDrainSuspended
        ? "The server is restarting — please try again in a moment."
        : executionDenial(this.userId, { includeDraining: true })?.message,
      ...(options.acquireBackgroundPermit
        ? { acquireBackgroundPermit: () => options.acquireBackgroundPermit!(this.rootAgentId) }
        : {}),
      ...(options.rejectBackgroundPermit
        ? { rejectBackgroundPermit: () => options.rejectBackgroundPermit!(this.rootAgentId) }
        : {}),
      onError: (error, context) => {
        logAudit("agent_supervisor_error", {
          userId: this.userId,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          level: "warn",
          data: {
            phase: context.phase,
            taskId: context.taskId ?? null,
            errorKind: errorKind(error),
          },
        });
      },
      onActive: () => {
        if (this.status !== "running") this.backgroundOutcomeAtForegroundEnd = null;
        this.publishStatusFeed("running");
      },
      onInvalidated: ({ revision }) => {
        this.emitWake({
          type: "orchestration_invalidated",
          resource: "session_run",
          sessionId: this.sessionId,
          revision,
        });
        this.emitWake({
          type: "orchestration_invalidated",
          resource: "activity",
          revision: orchestrationRevisionDao.activity(this.userId),
        });
      },
      onTaskChanged: (taskId) => options.onBackgroundTaskChanged?.(taskId),
      onRunnableHint: () => this.runtimeOptions.onBackgroundRunnable?.(this.rootAgentId),
      onIdle: (outcome) => {
        if (outcome === "parked") {
          if (this.status !== "running") this.publishStatusFeed(this.effectiveStatusFeed(this.status));
        } else if (this.status === "running") {
          this.backgroundOutcomeAtForegroundEnd = this.backgroundOutcomeAtForegroundEnd === "error"
            || outcome === "error" ? "error" : "done";
        } else {
          const deferred = this.backgroundOutcomeAtForegroundEnd;
          this.backgroundOutcomeAtForegroundEnd = null;
          this.publishStatusFeed(
            this.effectiveStatusFeed(this.status),
            this.status === "error" ? deferred ?? "error" : deferred ?? outcome,
          );
        }
        this.onBackgroundIdle?.();
      },
      onAttemptEnd: (taskId) => {
        this.refreshRecoveredJoinedProjection(taskId);
        this.onBackgroundAttemptEnd?.(taskId);
      },
      onJoinedProgress: ({ task, ownerStepId, progressSeq, at, event }) => {
        if (this.closed || task.ownerSessionId !== this.sessionId) return false;
        const parent = this.toolItems.get(ownerStepId);
        if (!parent) return false;
        const committed = joinedTaskProgressDao.commit({
          userId: this.userId,
          taskId: task.id,
          expectedLeaseGeneration: task.leaseGeneration,
          progressSeq,
          ownerTimelineSeq: parent.seq,
          event,
          at,
        });
        if (committed.kind === "stale") return false;
        if (committed.kind === "duplicate") return true;
        this.toolItems.set(ownerStepId, committed.parent);
        this.notePersisted(committed.parent);
        if (committed.wire === "snapshot") {
          if (!committed.parent.childProgress) throw new Error("Joined Child snapshot lost its cursor");
          this.emitAgent({
            t: "subagent_snapshot",
            parentId: ownerStepId,
            children: committed.parent.children ?? [],
            progress: committed.parent.childProgress,
          });
          if (committed.legacyFallback) {
            this.emitAgent({ t: "subagent_event", parentId: ownerStepId, event });
          }
        } else {
          this.emitAgent({
            t: "subagent_event",
            parentId: ownerStepId,
            taskId: task.id,
            leaseGeneration: task.leaseGeneration,
            progressSeq,
            progressAt: at,
            source: "worker",
            event,
          });
        }
        return true;
      },
    });
    this.statusFeedState = this.effectiveStatusFeed(this.status);

    this.toolSources = [
      builtinToolSource(
        this.sandbox,
        subagentRunner,
        this.workspaceWriteLease,
        agentRunner,
        workflowRunner,
      ),
      ...(options.teamCommands ? [{
        id: "team",
        listTools: async () => {
          return createTeamTools({
            commands: options.teamCommands!,
            activeParent: () => this.activeTeamToolParent(),
            ownerTurnId: () => this.currentTurnId ?? undefined,
          });
        },
      } satisfies ToolSource] : []),
      ...mcpServersFromEnv().map(mcpToolSource),
    ];

    if (this.interactiveActivation) {
      this.restorePendingRecap();
      this.scheduleQueuedTurns();
    }
    this.schedulePersistedResultAcks();
  }

  private ensureSessionAgentRoot(): string {
    const existing = agentNodeDao.rootBySession(this.userId, this.sessionId);
    const desired = "idle";
    if (!existing) {
      return agentNodeDao.create({
        id: `agt_root_${this.sessionId}`,
        userId: this.userId,
        sessionId: this.sessionId,
        rootAgentId: `agt_root_${this.sessionId}`,
        path: "/root",
        label: "Current session",
        kind: "session",
        status: desired,
        createdAt: Date.now(),
      }).id;
    }
    if (existing.status === "closed") throw new Error("Session Agent root is closed");
    let current = existing;
    for (let attempt = 0; attempt < 2 && current.status !== desired; attempt += 1) {
      const changed = agentNodeDao.transitionStatus({
        id: current.id,
        userId: this.userId,
        expectedVersion: current.version,
        nextStatus: desired,
        at: Date.now(),
      });
      if (!changed) throw new Error("Session Agent root changed during runtime construction");
      current = changed;
    }
    return current.id;
  }

  private requireAgentSupervisor(): AgentSupervisor {
    if (!this.agentSupervisor) throw new Error("Agent supervisor is not ready");
    return this.agentSupervisor;
  }

  activateInteractive(): void {
    if (this.closed || this.interactiveActivation) return;
    this.interactiveActivation = true;
    this.restorePendingRecap();
    this.scheduleQueuedTurns();
    this.agentSupervisor?.poke();
  }

  isInteractive(): boolean {
    return this.interactiveActivation;
  }

  getRootAgentId(): string {
    return this.rootAgentId;
  }

  pokeBackgroundTasks(): void {
    this.agentSupervisor?.poke();
  }

  interruptBackgroundTask(taskId: string, expectedTaskLeaseGeneration: number): boolean {
    return this.agentSupervisor?.interruptTask(taskId, expectedTaskLeaseGeneration) ?? false;
  }

  private resolveRosterAgent(target: string): AgentNode {
    return this.requireAgentSupervisor().resolveAddressableTarget(target);
  }

  private async childContextSeed(
    parentAgentId: string | undefined,
    provider: string | undefined,
    model: string | undefined,
    mode: Exclude<PiChildContextMode, "none">,
    limits: Readonly<{ maxMessages: number; maxMessageBytes: number; maxBytes: number }>,
  ): Promise<Message[]> {
    const source = !parentAgentId || parentAgentId === this.rootAgentId
      ? convertTeamMessagesToLlm(this.agent.state.messages)
      : (this.agentSupervisor?.liveContext(parentAgentId) as readonly Message[] | undefined)
        ?? (agentMessageDao.load(this.userId, parentAgentId)?.messages as readonly Message[] | undefined)
        ?? [];
    const messages = projectPiChildTranscript(
      source.map((message) => JSON.parse(JSON.stringify(message)) as Message),
    ) as unknown as Message[];
    if (!provider || !model) throw new Error("Child Agent has no pinned model provenance");
    const childModel = resolveModel(provider, model);
    const seedTokenLimit = Math.max(
      1_024,
      childModel.contextWindow - reserveTokensFor(childModel) - Math.max(4_096, Math.round(childModel.contextWindow * 0.04)),
    );
    const bytes = messages.map((message) => Buffer.byteLength(JSON.stringify(message), "utf8"));
    const hardTokens = await Promise.all(messages.map((message) => countMessageHard(message)));
    const fits = (start: number, tokenLimit: number): boolean => {
      if (messages.length - start > limits.maxMessages) return false;
      let totalBytes = 0;
      let totalTokens = 0;
      for (let index = start; index < messages.length; index += 1) {
        if (bytes[index]! > limits.maxMessageBytes) return false;
        totalBytes += bytes[index]!;
        totalTokens += hardTokens[index]!;
        if (totalBytes > limits.maxBytes || totalTokens > tokenLimit) return false;
      }
      return true;
    };
    if (messages.length === 0) return [];
    if (mode === "all") {
      if (messages[0]?.role !== "user" || !fits(0, seedTokenLimit)) {
        throw new RangeError("Full parent context exceeds the bounded Child Agent handoff");
      }
      return messages;
    }
    let selected = messages.length;
    for (let start = messages.length - 1; start >= 0; start -= 1) {
      if (messages[start]?.role !== "user") continue;
      if (fits(start, Math.min(2_000, seedTokenLimit))) selected = start;
    }
    return selected < messages.length ? messages.slice(selected) : [];
  }

  private createAgentOrchestrationRunner(parentAgentId?: string): AgentOrchestrationRunner {
    const currentParentTask = () => {
      if (!parentAgentId) return undefined;
      const task = runtimeTaskDao.listOpenByAgent(
        this.userId,
        parentAgentId,
        this.requireAgentSupervisor().limits.maxOpenTasks,
      ).find((candidate) => ["starting", "running", "waiting", "cancel_requested"].includes(candidate.status));
      if (!task) throw new Error("The calling Child Agent no longer owns an active Task");
      return task;
    };
    return {
      spawn: async (input, signal) => {
        if (signal?.aborted) throw signal.reason ?? new Error("Agent spawn aborted");
        const parentTask = currentParentTask();
        const parentAgent = parentAgentId
          ? agentNodeDao.byId(this.userId, parentAgentId)
          : undefined;
        const configured = sessionDao.byId(this.sessionId) ?? this.row;
        const turnSnapshot = this.currentTurnExecution;
        const provider = parentAgent?.provider ?? turnSnapshot?.provider ?? configured.provider;
        const model = parentAgent?.model ?? turnSnapshot?.model ?? configured.model;
        const modelInfo = resolveModel(provider, model);
        const thinkingLevel = parentAgent?.thinkingLevel
          ?? turnSnapshot?.thinkingLevel
          ?? effectiveThinkingLevel(modelInfo, configured.thinking_level);
        const initialMessages = input.context === "none"
          ? []
          : await this.childContextSeed(
            parentAgentId ?? this.rootAgentId,
            provider,
            model,
            input.context,
            {
              maxMessages: PI_CHILD_SEED_MAX_MESSAGES,
              maxMessageBytes: PI_CHILD_SEED_MAX_MESSAGE_BYTES,
              maxBytes: PI_CHILD_SEED_MAX_BYTES,
            },
          );
        const handle = this.requireAgentSupervisor().spawn({
          taskName: input.taskName,
          message: input.message,
          context: input.context,
          provider,
          model,
          thinkingLevel,
          initialMessages: initialMessages.map((message) =>
            JSON.parse(JSON.stringify(message)) as OrchestrationJson),
          ...(parentAgentId ? { parentAgentId } : {}),
          ...(parentTask ? { parentTaskId: parentTask.id } : {}),
          ownerTurnId: parentTask?.ownerTurnId ?? this.currentTurnId ?? undefined,
          ownerStepId: input.ownerStepId,
          awaitPolicy: "background",
          cancelPolicy: "detached",
        });
        return `Started ${handle.path}; task=${handle.taskId}; roster=v${handle.revision}.`;
      },
      list: ({ pathPrefix }) => {
        const roster = this.requireAgentSupervisor().modelRoster();
        const aliases = stableAgentAliases(roster.nodes, roster.tasks.map((task) => task.agentId));
        const prefix = pathPrefix?.replace(/\/$/, "");
        const nodes = roster.nodes.filter((node) =>
          node.id !== this.rootAgentId && (!prefix || node.path === prefix || node.path.startsWith(`${prefix}/`)));
        if (nodes.length === 0) return `roster=v${roster.revision}; no matching Agents.`;
        const rows = nodes.slice(0, 32).map((node) => {
          const active = roster.tasks.find((task) => task.agentId === node.id
            && !["succeeded", "failed", "cancelled", "interrupted"].includes(task.status));
          return `${aliases.get(node.id)} ${node.path} ${node.status}${active ? ` task=${active.status}:${active.title}` : ""}`;
        });
        return `roster=v${roster.revision}\n${rows.join("\n")}`;
      },
      get: ({ target, ownerStepId }) => {
        const agent = this.resolveRosterAgent(target);
        const tasks = runtimeTaskDao.listDigestsByAgent(this.userId, agent.id, 8);
        const observedResults: Array<{ taskId: string; expectedVersion: number }> = [];
        let detailedResults = 0;
        const rows = tasks.map((task) => {
          const result = taskResultDao.byTask(this.userId, task.id);
          const exposeSummary = Boolean(result && detailedResults < 2);
          if (result && exposeSummary) detailedResults += 1;
          if (result && exposeSummary && result.acknowledgedAt === undefined) {
            observedResults.push({ taskId: task.id, expectedVersion: result.version });
          }
          return `${task.status} ${task.title}${task.activity ? ` @${task.activity}` : ""}`
            + `${result ? exposeSummary ? `\n  result: ${truncateUtf8(result.summary, 3 * 1024)}` : "\n  result: available (read in a later get_agent call)" : ""}`;
        });
        taskResultDeliveryDao.stage({
          userId: this.userId,
          sessionId: this.sessionId,
          deliveryAgentId: parentAgentId ?? this.rootAgentId,
          deliveryStepId: ownerStepId,
          results: observedResults,
          at: Date.now(),
        });
        return truncateUtf8(
          `${agent.path} ${agent.status} v${agent.version}${rows.length ? `\n${rows.join("\n")}` : "\nno Tasks"}`,
          16 * 1024,
        );
      },
      wait: async ({ targets, timeoutMs }, signal) => {
        const resolvedTargets = targets?.map((target) => this.resolveRosterAgent(target).id);
        const waited = await this.requireAgentSupervisor().waitForChange({
          targets: resolvedTargets,
          timeoutMs,
          signal,
          visibility: "addressable",
        });
        const rows = waited.agents.map((agent) => `${agent.path} ${agent.status}`);
        return `roster=v${waited.revision}; ${waited.timedOut ? "timeout" : waited.changed ? "changed" : "unchanged"}`
          + `${rows.length ? `\n${rows.join("\n")}` : ""}`;
      },
      send: async ({ target, message }) => {
        const agent = this.resolveRosterAgent(target);
        await this.requireAgentSupervisor().send(agent.id, message);
        return `Queued steering for ${agent.path}.`;
      },
      followUp: async ({ target, message, ownerStepId }, signal) => {
        if (signal?.aborted) throw signal.reason ?? new Error("Agent follow-up aborted");
        const agent = this.resolveRosterAgent(target);
        const parentTask = currentParentTask();
        const handle = this.requireAgentSupervisor().followUp({
          target: agent.id,
          message,
          ...(parentTask ? { parentTaskId: parentTask.id } : {}),
          ownerTurnId: parentTask?.ownerTurnId ?? this.currentTurnId ?? undefined,
          ownerStepId,
          awaitPolicy: "background",
          cancelPolicy: "detached",
        });
        return `Queued follow-up for ${handle.path}; task=${handle.taskId}; roster=v${handle.revision}.`;
      },
      interrupt: ({ target }) => {
        const agent = this.resolveRosterAgent(target);
        return this.requireAgentSupervisor().interrupt(agent.id)
          ? `Interrupt requested for ${agent.path}.`
          : `No active Task for ${agent.path}.`;
      },
    };
  }

  private createWorkflowRunner(): WorkflowRunner {
    return {
      run: (input, signal) => {
        if (signal?.aborted) throw signal.reason ?? new Error("Workflow launch aborted");
        const denial = this.queuedDrainSuspended
          ? "The server is restarting — please try again in a moment."
          : executionDenial(this.userId, { includeDraining: true })?.message;
        if (denial) throw new Error(denial);
        const configured = sessionDao.byId(this.sessionId) ?? this.row;
        const turnSnapshot = this.currentTurnExecution;
        const provider = turnSnapshot?.provider ?? configured.provider;
        const model = turnSnapshot?.model ?? configured.model;
        const modelInfo = resolveModel(provider, model);
        const thinkingLevel = turnSnapshot?.thinkingLevel
          ?? effectiveThinkingLevel(modelInfo, configured.thinking_level);
        const launcher = new WorkflowLaunchService({
          userId: this.userId,
          sessionId: this.sessionId,
          rootAgentId: this.rootAgentId,
          maxTreeAgents: this.requireAgentSupervisor().limits.maxTreeAgents,
          onChanged: (workflow) => this.runtimeOptions.onWorkflowChanged?.(workflow),
        });
        const launched = input.controller
          ? launcher.launchDynamic({
            name: input.name,
            controller: input.controller,
            budget: input.budget,
            provider,
            model,
            thinkingLevel,
          })
          : launcher.launch({
            name: input.name,
            nodes: input.nodes ?? [],
            budget: input.budget,
            provider,
            model,
            thinkingLevel,
          });
        const workflow = launched.snapshot.workflow;
        return JSON.stringify({
          workflowId: workflow.id,
          name: workflow.name,
          status: workflow.status,
          nodes: launched.executors.map((executor) => ({
            nodeId: executor.nodeId,
            agent: executor.path,
          })),
          message: "Workflow started in the background. Use Agent status Tools only when you need detail.",
        });
      },
    };
  }

  private async promptWithAgentRoster(base: string): Promise<string> {
    const supervisor = this.agentSupervisor;
    const teamContext = teamDao.contextForSession(this.userId, this.sessionId);
    const teamBlock = teamContext.teams.length > 0 || teamContext.results.length > 0
      ? `\n\n---\n\nTeam context (bounded metadata):\n${JSON.stringify(teamContext)}`
      : "";
    if (!supervisor) return base + teamBlock;
    const roster = supervisor.modelRoster();
    const hasChild = roster.nodes.some((node) => node.id !== this.rootAgentId && node.status !== "closed");
    const hasTask = (roster.counts?.tasks ?? roster.tasks.length) > 0;
    if (!hasChild && !hasTask) return base + teamBlock;
    const digest = await this.contextDigestRenderer.render(roster);
    return `${base}\n\n---\n\n${digest.text}${teamBlock}`;
  }

  private async streamWithAgentContext(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ) {
    const base = context.systemPrompt ?? this.agent.state.systemPrompt ?? this.systemPrompt;
    const systemPrompt = await this.promptWithAgentRoster(base);
    this.effectiveSystemPrompt = systemPrompt;
    let streamOptions = options;

    await this.compactBetweenRounds(options?.signal);

    let providerContext = { ...context, messages: convertTeamMessagesToLlm(this.agent.state.messages) };
    if (this.currentTeamTurnTaskId) {
      const attempt = this.currentTeamAttempt;
      if (!attempt) throw new Error("Team provider request has no active durable lease");
      let inputUpperBound = await this.providerInputUpperBound(
        systemPrompt,
        providerContext.messages,
        providerContext.tools ?? [],
      );
      const remaining = teamTaskDao.remainingProviderBudget({
        userId: this.userId,
        taskId: this.currentTeamTurnTaskId,
        expectedTaskLeaseGeneration: attempt.taskGeneration,
        mailId: attempt.mailId,
        claimToken: attempt.claimToken,
        claimGeneration: attempt.claimGeneration,
        at: Date.now(),
      });
      if (!remaining || remaining.maxModelCycles < 1 || remaining.maxTokens < 1) {
        throw new Error("Team route has no remaining provider-request budget");
      }
      const maxInputTokens = remaining.maxTokens - TEAM_PROVIDER_MIN_OUTPUT_TOKENS;
      if (maxInputTokens < 1) {
        throw new Error("Team provider request cannot fit the provider's minimum output allowance");
      }
      if (inputUpperBound > maxInputTokens) {
        const compacted = await this.maybeCompact(this.turnAbort?.signal, true, {
          maxInputTokens,
          phase: "team_budget_fit",
        });
        if (!compacted) {
          throw new Error("Team provider request exceeds its remaining token budget");
        }
        providerContext = {
          ...context,
          messages: convertTeamMessagesToLlm(this.agent.state.messages),
        };
        inputUpperBound = await this.providerInputUpperBound(
          systemPrompt,
          providerContext.messages,
          providerContext.tools ?? [],
        );
        if (inputUpperBound > maxInputTokens) {
          throw new Error("Compacted Team provider request still exceeds its remaining token budget");
        }
      }
      const reservation = teamTaskDao.reserveProviderRequest({
        userId: this.userId,
        taskId: this.currentTeamTurnTaskId,
        expectedTaskLeaseGeneration: attempt.taskGeneration,
        mailId: attempt.mailId,
        claimToken: attempt.claimToken,
        claimGeneration: attempt.claimGeneration,
        at: Date.now(),
      });
      try {
        const maxOutput = reservation.reservedTokens - inputUpperBound;
        if (maxOutput < TEAM_PROVIDER_MIN_OUTPUT_TOKENS) {
          throw new Error("Team provider request exceeds its remaining token budget");
        }
        this.currentTeamTokenReservations.push({
          reservedTokens: reservation.reservedTokens,
          inputUpperBound,
        });
        streamOptions = {
          ...options,
          maxTokens: Math.max(
            TEAM_PROVIDER_MIN_OUTPUT_TOKENS,
            Math.min(options?.maxTokens ?? maxOutput, maxOutput),
          ),
        };
      } catch (error) {
        teamTaskDao.cancelProviderReservation({
          userId: this.userId,
          taskId: this.currentTeamTurnTaskId,
          expectedTaskLeaseGeneration: attempt.taskGeneration,
          mailId: attempt.mailId,
          claimToken: attempt.claimToken,
          claimGeneration: attempt.claimGeneration,
          reservedTokens: reservation.reservedTokens,
          at: Date.now(),
        });
        throw error;
      }
    }
    return streamSimple(model, { ...providerContext, systemPrompt }, streamOptions);
  }

  private async providerInputUpperBound(
    systemPrompt: string,
    messages: Context["messages"],
    tools: NonNullable<Context["tools"]>,
  ): Promise<number> {
    const messageTokens = await Promise.all(messages.map((message) => countMessageHard(message)));
    const systemTokens = await countTextHard(systemPrompt);
    const toolTokens = tools.length ? await countTextHard(JSON.stringify(tools)) : 0;
    const tokenizerCount = messageTokens.reduce((sum, count) => sum + count, 0) + systemTokens + toolTokens;
    const serializedBytes = Buffer.byteLength(JSON.stringify({ systemPrompt, messages, tools }), "utf8");
    const framingUpperBound = serializedBytes + 64 * (messages.length + tools.length + 1);
    return Math.max(tokenizerCount, framingUpperBound);
  }

  private toolSources: ToolSource[] = [];
  private toolsReady: Promise<void> | null = null;

  private ensureTools(): Promise<void> {
    if (!this.toolsReady) {
      this.toolsReady = composeTools(this.toolSources)
        .then((tools) => {
          if (!this.closed && tools.length) this.agent.state.tools = tools;
        })
        .catch((e) => console.error("[agent-session] tool composition failed:", e instanceof Error ? e.message : e));
    }
    return this.toolsReady;
  }

  subscribe(listener: (ev: ServerEvent) => void): () => void {
    this.activateInteractive();
    this.listeners.add(listener);
    this.agentSupervisor?.poke();
    this.startLoadSampler();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopLoadSampler();
    };
  }

  private startLoadSampler(): void {
    if (!this.loadStopped || !this.sandbox.metrics) return;
    this.loadStopped = false;
    void this.sampleLoadLoop();
  }

  private stopLoadSampler(): void {
    this.loadStopped = true;
    if (this.loadTimer != null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
  }

  private async sampleLoadLoop(): Promise<void> {
    if (this.loadStopped || this.listeners.size === 0 || !this.sandbox.metrics) return;
    const load = await this.sandbox.metrics().catch(() => null);
    if (this.loadStopped || this.listeners.size === 0) return;
    if (load) {
      this.emit({
        type: "sandbox_load",
        sessionId: this.sessionId,
        kind: this.row.sandbox_kind,
        cpuPct: load.cpuPct,
        memUsed: load.memUsed,
        memTotal: load.memTotal,
      });
    }
    this.loadTimer = setTimeout(() => void this.sampleLoadLoop(), LOAD_SAMPLE_MS);
  }

  private emit(ev: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(ev);
      } catch (error) {
        this.reportObserverFailure("subscriber", ev.type, error);
      }
    }
  }

  private emitWake(event: ServerEvent): void {
    try {
      this.onWake?.(event);
    } catch (error) {
      this.reportObserverFailure("status_feed", event.type, error);
    }
  }

  private reportObserverFailure(channel: "subscriber" | "status_feed", eventType: string, error: unknown): void {
    try {
      logAudit("runtime_observer_failed", {
        level: "warn",
        userId: this.userId,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: { channel, eventType, errorKind: errorKind(error) },
      });
    } catch {
    }
  }

  private hintAgentSupervisor(phase: string): void {
    try {
      this.agentSupervisor?.poke();
    } catch (error) {
      try {
        logAudit("agent_supervisor_hint_failed", {
          level: "warn",
          userId: this.userId,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { phase, errorKind: errorKind(error) },
        });
      } catch {
      }
    }
  }

  private compactionReserveTokens(): number {
    return reserveTokensFor(this.model);
  }

  private compactTriggerAt(): number {
    return triggerAtFor(this.model);
  }

  private promptExceedsWindow(): boolean {
    const contextWindow = (this.model as { contextWindow?: number }).contextWindow ?? 0;
    if (!contextWindow) return false;
    try {
      return this.getContextUsage().used > contextWindow;
    } catch {
      return false;
    }
  }

  getContextUsage(): ContextUsage {
    let toolsJson = "";
    try {
      toolsJson = JSON.stringify(this.agent.state.tools ?? []);
    } catch {
    }
    return computeContextUsage(
      this.model,
      convertTeamMessagesToLlm(this.agent.state.messages),
      this.effectiveSystemPrompt,
      toolsJson,
      this.lastContextTokens,
    );
  }

  private emitContextUsage(): void {
    this.emit({ type: "context_usage", sessionId: this.sessionId, ...this.getContextUsage() });
  }

  private clearRecapTimer(): void {
    if (this.recapTimer != null) {
      clearTimeout(this.recapTimer);
      this.recapTimer = null;
    }
  }

  private clearPendingRecap(preserveDurableJob = false): void {
    this.clearRecapTimer();
    if (!preserveDurableJob && this.pendingRecap) recapJobDao.delete(this.sessionId);
    this.pendingRecap = null;
    this.recapTurnCompleted = false;
    this.recapTurnId = null;
  }

  private restorePendingRecap(): void {
    const row = recapJobDao.get(this.sessionId);
    if (!row) return;
    if (RECAP_IDLE_MS <= 0) {
      recapJobDao.delete(this.sessionId);
      return;
    }
    const pending = decodeRecapJob(row);
    if (!pending) {
      recapJobDao.delete(this.sessionId);
      logAudit("recap_job_dropped", {
        level: "warn",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: { contractVersion: row.contract_version, reason: "unsupported_or_invalid" },
      });
      return;
    }
    this.pendingRecap = pending;
    this.recapTurnId = pending.turnId;
    this.recapTurnCompleted = true;
    this.scheduleRecap(Math.max(0, pending.dueAt - Date.now()));
  }

  private recapSnapshot(): RecapSnapshotV1 {
    return buildRecapSnapshot({
      recentRequests: timelineDao.recentUserTexts(this.sessionId, 3),
      latestRequest: this.recapLastUserText,
      assistantReply: this.recapLastAssistantText,
      activity: this.recapActivity,
      turnProvider: this.model.provider,
      turnModel: this.model.id,
    });
  }

  private scheduleRecapAfterTurn(): void {
    this.clearRecapTimer();
    if (this.closed || this.status !== "idle" || !this.recapTurnCompleted || RECAP_IDLE_MS <= 0) return;
    const now = Date.now();
    const pending: PendingRecap = {
      turnId: this.recapTurnId ?? `turn_at_${this.timelineSeq}`,
      anchorSeq: timelineDao.maxSeq(this.sessionId),
      dueAt: now + RECAP_IDLE_MS,
      contractVersion: RECAP_CONTRACT_VERSION,
      snapshot: this.recapSnapshot(),
    };
    try {
      recapJobDao.upsert({
        session_id: this.sessionId,
        turn_id: pending.turnId,
        anchor_seq: pending.anchorSeq,
        due_at: pending.dueAt,
        contract_version: pending.contractVersion,
        payload_json: JSON.stringify(pending.snapshot),
        created_at: now,
      });
    } catch (e) {
      logAudit("recap_job_failed", {
        level: "warn",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: { contractVersion: RECAP_CONTRACT_VERSION, errorKind: errorKind(e) },
      });
      return;
    }
    this.pendingRecap = pending;
    this.recapTurnId = pending.turnId;
    this.scheduleRecap(RECAP_IDLE_MS);
  }

  private scheduleRecap(delayMs: number): void {
    if (this.closed || this.status !== "idle" || !this.pendingRecap || RECAP_IDLE_MS <= 0) return;
    this.recapTimer = setTimeout(() => this.emitRecapIfQuiet(), Math.max(0, delayMs));
    this.recapTimer.unref?.();
  }

  private emitRecapIfQuiet(): void {
    this.recapTimer = null;
    const pending = this.pendingRecap;
    if (this.closed || this.status !== "idle" || !pending || RECAP_IDLE_MS <= 0) return;
    const now = Date.now();
    if (now < pending.dueAt) {
      this.scheduleRecap(pending.dueAt - now);
      return;
    }
    void generateRecapText(pending.snapshot, {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
    })
      .then((generation) => {
        if (this.closed || this.status !== "idle" || this.pendingRecap?.turnId !== pending.turnId) return;
        const item: Extract<TimelineItem, { kind: "recap" }> = {
          kind: "recap",
          id: `recap_${crypto.createHash("sha256").update(`${this.sessionId}:${pending.turnId}:${pending.contractVersion}`).digest("hex").slice(0, 24)}`,
          seq: this.nextSeq(),
          text: generation.text,
          ts: Date.now(),
          anchorSeq: pending.anchorSeq,
          contractVersion: pending.contractVersion,
          source: generation.source,
          generatorProvider: generation.generatorProvider,
          generatorModel: generation.generatorModel,
          turnProvider: pending.snapshot.turnProvider,
          turnModel: pending.snapshot.turnModel,
          sourceTurnId: pending.turnId,
        };
        const committed = runInTransaction(() => {
          const live = recapJobDao.get(this.sessionId);
          if (!live || live.turn_id !== pending.turnId || live.contract_version !== pending.contractVersion) return false;
          timelineDao.append(this.sessionId, item);
          recapJobDao.deleteIfTurn(this.sessionId, pending.turnId);
          return true;
        });
        if (!committed) return;
        this.notePersisted(item);
        this.pendingRecap = null;
        this.recapTurnCompleted = false;
        this.recapTurnId = null;
        logAudit("recap_generated", {
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            contractVersion: item.contractVersion,
            source: item.source,
            generatorProvider: item.generatorProvider,
            generatorModel: item.generatorModel,
            turnProvider: item.turnProvider,
            turnModel: item.turnModel,
            previousRequestCount: pending.snapshot.previousRequests.length,
            activityCount: pending.snapshot.activity.length,
            latestRequestChars: pending.snapshot.latestRequest.length,
            assistantReplyChars: pending.snapshot.assistantReply.length,
            dueLagMs: Math.max(0, item.ts - pending.dueAt),
          },
        });
        this.emitAgent({
          t: "recap",
          id: item.id,
          seq: item.seq,
          text: item.text,
          ts: item.ts,
          anchorSeq: item.anchorSeq,
          contractVersion: item.contractVersion,
          source: item.source,
          generatorProvider: item.generatorProvider,
          generatorModel: item.generatorModel,
          turnProvider: item.turnProvider,
          turnModel: item.turnModel,
          sourceTurnId: item.sourceTurnId,
        });
      })
      .catch((e) => {
        if (this.closed || this.status !== "idle" || this.pendingRecap?.turnId !== pending.turnId) return;
        logAudit("recap_commit_failed", {
          level: "warn",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { contractVersion: pending.contractVersion, errorKind: errorKind(e) },
        });
        this.scheduleRecap(RECAP_COMMIT_RETRY_MS);
      });
  }

  private trackRecapEvent(event: WireAgentEvent): void {
    if (this.currentTeamTurnTaskId) {
      if (event.t === "turn_start" || event.t === "error") this.clearPendingRecap();
      if (event.t === "turn_end") {
        this.clearRecapTimer();
        this.recapTurnCompleted = false;
        this.recapTurnId = null;
      }
      return;
    }
    if (event.t === "turn_start") {
      this.clearPendingRecap();
      this.recapTurnId = event.turnId;
      return;
    }
    if (event.t === "turn_end") {
      this.clearRecapTimer();
      this.recapTurnCompleted = event.status === "completed";
      if (this.status === "idle") this.scheduleRecapAfterTurn();
      return;
    }
    if (event.t === "error") {
      this.clearPendingRecap();
      return;
    }
    if (event.t === "user_message") {
      this.recapLastUserText = event.text;
      this.recapLastAssistantText = "";
    } else if (event.t === "tool_start") {
      if (this.recapActivity.length < 40) {
        this.recapActivity.push({ name: event.name, kind: event.toolKind, path: event.path });
      }
    } else if (event.t === "assistant_update" || event.t === "assistant_end") {
      this.recapLastAssistantText = event.blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    }
  }

  private emitAgent(event: WireAgentEvent): void {
    this.trackRecapEvent(event);
    if (event.t === "assistant_update") {
      this.pendingUpdate = event;
      if (this.updateTimer == null) this.flushUpdate();
      return;
    }
    this.flushUpdate();
    this.rawEmitAgent(event);
  }

  private flushUpdate(): void {
    if (this.updateTimer != null) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.pendingUpdate == null) return;
    const ev = this.pendingUpdate;
    this.pendingUpdate = null;
    this.rawEmitAgent(ev);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.flushUpdate();
    }, UPDATE_COALESCE_MS);
  }

  private rawEmitAgent(event: WireAgentEvent): void {
    this.emit({
      type: "agent_event",
      sessionId: this.sessionId,
      epoch: this.epoch,
      version: this.timelineVersion,
      seq: this.wireSeq++,
      ts: Date.now(),
      event,
    });
  }

  private setStatus(status: SessionStatus, persist = true): void {
    if (this.closed) return;
    const prev = this.status;
    this.status = status;
    if (status === "idle" && prev === "running") this.scheduleRecapAfterTurn();
    else if (status !== "idle") this.clearPendingRecap();
    if (persist) sessionDao.setStatus(this.sessionId, status);
    this.emit({ type: "session_status", sessionId: this.sessionId, status });
    this.emitWake({ type: "session_status", sessionId: this.sessionId, status });
    const deferred = status === "idle" ? this.backgroundOutcomeAtForegroundEnd : null;
    if (status === "idle") this.backgroundOutcomeAtForegroundEnd = null;
    const activity = this.effectiveStatusFeed(status);
    const terminalWake = status === "error" ? "error" : deferred ?? undefined;
    if (terminalWake && activity === "running") {
      this.backgroundOutcomeAtForegroundEnd = this.backgroundOutcomeAtForegroundEnd === "error"
        || terminalWake === "error" ? "error" : "done";
    }
    this.publishStatusFeed(
      activity,
      terminalWake,
    );
  }

  private effectiveStatusFeed(status: SessionStatus): SessionStatus {
    return status === "running" || this.hasBackgroundTasks() ? "running" : status;
  }

  private publishStatusFeed(status: SessionStatus, terminalWake?: "done" | "error"): void {
    const previous = this.statusFeedState;
    this.statusFeedState = status;
    this.emitWake({ type: "session_activity", sessionId: this.sessionId, activity: status });
    if (terminalWake && status !== "running") this.wake(terminalWake);
    else if (status === "running" && previous !== "running") this.wake("running");
    else if (status === "idle" && previous === "running" && !this.hasOpenAgentTasks()) this.wake("done");
  }

  private wake(kind: "running" | "done" | "error" | "approval"): void {
    this.emitWake({
      type: "session_wake",
      sessionId: this.sessionId,
      title: normalizeSessionTitle(this.row.title, "Untitled session"),
      kind,
    });
  }

  private publishOrchestrationChanges(changes: readonly OrchestrationRevisionChange[]): void {
    let activityRevision = 0;
    const sessionRevisions = new Map<string, number>();
    for (const change of changes) {
      activityRevision = Math.max(activityRevision, change.activityRevision);
      sessionRevisions.set(
        change.sessionId,
        Math.max(sessionRevisions.get(change.sessionId) ?? 0, change.revision),
      );
    }
    for (const [sessionId, revision] of sessionRevisions) {
      this.emitWake({ type: "orchestration_invalidated", resource: "session_run", sessionId, revision });
    }
    if (activityRevision > 0) {
      this.emitWake({ type: "orchestration_invalidated", resource: "activity", revision: activityRevision });
    }
  }

  private schedulePersistedResultAcks(): void {
    if (this.resultAckDrainTimer !== null) return;
    this.resultAckDrainTimer = setTimeout(() => {
      this.resultAckDrainTimer = null;
      this.commitPersistedResultAcks();
    }, 0);
    this.resultAckDrainTimer.unref?.();
  }

  private commitPersistedResultAcks(): void {
    try {
      this.publishOrchestrationChanges(
        taskResultDeliveryDao.commitPersisted(this.userId, this.sessionId, Date.now()),
      );
    } catch (error) {
      logAudit("agent_result_ack_deferred", {
        level: "warn",
        userId: this.userId,
        sessionId: this.sessionId,
        data: { reason: errorKind(error) },
      });
    }
  }

  private discardResultAckStage(
    deliveryAgentId: string,
    stepId: string,
    preserveErrorDeliveries = false,
  ): void {
    try {
      taskResultDeliveryDao.discard({
        userId: this.userId,
        sessionId: this.sessionId,
        deliveryAgentId,
        deliveryStepIds: [stepId],
        preserveErrorDeliveries,
      });
    } catch {
    }
  }

  private auditTargetId(): string | null {
    return this.row.sandbox_target_id ?? this.row.sandbox_id ?? null;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getActivityStatus(): SessionStatus {
    return this.effectiveStatusFeed(this.status);
  }

  getTimeline(): TimelineItem[] {
    if (this.timelineCache === null) {
      this.timelineCache = timelineDao.list(this.sessionId);
      this.timelineCacheIndex.clear();
      this.timelineCache.forEach((item, index) => this.timelineCacheIndex.set(item.seq, index));
    }
    if (this.toolStartedAt.size === 0) return this.timelineCache.slice();
    const now = Date.now();
    const withRunningElapsed = (items: TimelineItem[]): TimelineItem[] => {
      let changed = false;
      const snapshot = items.map((item) => {
        if (item.kind !== "tool") return item;
        const children = item.children ? withRunningElapsed(item.children) : item.children;
        const startedAt = item.status === "running" ? this.toolStartedAt.get(item.id) : undefined;
        if (startedAt === undefined && children === item.children) return item;
        changed = true;
        return {
          ...item,
          ...(startedAt === undefined ? {} : { runningElapsedMs: Math.max(0, now - startedAt) }),
          children,
        };
      });
      return changed ? snapshot : items;
    };
    const snapshot = withRunningElapsed(this.timelineCache);
    return snapshot === this.timelineCache ? snapshot.slice() : snapshot;
  }

  getPendingQueue(): PendingMessage[] {
    return pendingMessageDao.listPending(this.sessionId);
  }

  private emitPendingQueue(): void {
    this.emit({
      type: "pending_queue",
      sessionId: this.sessionId,
      epoch: this.epoch,
      version: this.timelineVersion,
      pending: pendingMessageDao.listPending(this.sessionId),
    });
  }

  private pendingQueueChanged(): void {
    this.timelineVersion++;
  }

  getEpoch(): string {
    return this.epoch;
  }

  getTimelineVersion(): number {
    return this.timelineVersion;
  }

  rewind(toSeq: number, authEpoch?: number): { ok: true; cut: number } | { ok: false; reason: "busy" | "not-rewindable" | "compacted" } {
    if (this.isBusy() || this.hasOpenAgentTasks()) return { ok: false, reason: "busy" };
    if (toSeq <= timelineDao.latestCompactionSeq(this.sessionId)) return { ok: false, reason: "compacted" };
    if (timelineDao.kindAt(this.sessionId, toSeq) !== "user") return { ok: false, reason: "not-rewindable" };
    if (runtimeTaskDao.ownedAtOrAfterTimelineSeq(this.userId, this.sessionId, toSeq)) {
      return { ok: false, reason: "not-rewindable" };
    }
    const cut = timelineDao.msgCutAt(this.sessionId, toSeq);
    const messages = this.agent.state.messages as AgentMessage[];
    if (cut == null || !Number.isInteger(cut) || cut < 0 || cut > messages.length) return { ok: false, reason: "not-rewindable" };
    const sliced = messages.slice(0, cut);
    runInImmediateTransaction(() => {
      assertAuthEpochInWriterTransaction(this.userId, authEpoch);
      requestCaptureDao.truncateFrom(this.sessionId, toSeq);
      timelineDao.truncateFrom(this.sessionId, toSeq);
      agentTurnDao.truncateFrom(this.sessionId, toSeq);
      messageDao.replaceAll(this.sessionId, sliced);
      recapJobDao.delete(this.sessionId);
      pendingMessageDao.deleteAll(this.sessionId);
      sessionDao.setStatus(this.sessionId, "idle");
    });
    this.agent.clearAllQueues();
    this.status = "idle";
    logAudit("session_rewind", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { toSeq, cut: sliced.length },
    });
    return { ok: true, cut: sliced.length };
  }

  async writeUpload(name: string, data: Uint8Array): Promise<{ path: string }> {
    const safe =
      (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "_").replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
    const rel = `uploads/${safe}`;
    await this.sandbox.writeFileBytes(rel, data, { allowReadOnly: true });
    return { path: rel };
  }

  async attachPty(opts: {
    cols: number;
    rows: number;
    create: boolean;
    onData: (chunk: Uint8Array) => void;
    onExit: (code: number | null) => void;
  }): Promise<{ viewer: number; status: "attached" | "spawned" | "none" }> {
    if (!opts.create && !this.pty && !this.ptyOpening) {
      this.logPtyAudit("probe-none", opts.cols, opts.rows);
      return { viewer: 0, status: "none" };
    }
    const viewer = ++this.ptyViewerSeq;
    this.ptyViewer = viewer;
    this.ptyClient = { onData: opts.onData, onExit: opts.onExit };
    if (this.ptyGraceTimer) {
      clearTimeout(this.ptyGraceTimer);
      this.ptyGraceTimer = null;
    }
    if (this.pty || this.ptyOpening) {
      if (this.pty) {
        void Promise.resolve(this.pty.resize(opts.cols, opts.rows)).catch(() => {});
        if (this.ptyRing.length === 1) {
          opts.onData(this.ptyRing[0]);
        } else if (this.ptyRing.length > 1) {
          const merged = new Uint8Array(this.ptyRingBytes);
          let off = 0;
          for (const chunk of this.ptyRing) { merged.set(chunk, off); off += chunk.length; }
          opts.onData(merged);
        }
      }
      this.logPtyAudit("attach", opts.cols, opts.rows);
      return { viewer, status: "attached" };
    }
    this.logPtyAudit("spawn", opts.cols, opts.rows);
    this.ptyOpening = true;
    const gen = ++this.ptyGen;
    let exited = false;
    try {
      const handle = await this.sandbox.openPty({
        cols: opts.cols,
        rows: opts.rows,
        onData: (chunk) => {
          if (this.ptyGen !== gen) return;
          this.pushPtyRing(chunk);
          this.ptyClient?.onData(chunk);
        },
        onExit: (code) => {
          exited = true;
          if (this.ptyGen !== gen) return;
          this.handlePtyExit(code);
        },
      });
      if (this.ptyGen !== gen || exited || this.ptyViewer === 0) {
        void Promise.resolve(handle.kill()).catch(() => {});
        return { viewer, status: "spawned" };
      }
      this.pty = handle;
      this.ptyInput = new PtyInputQueue((data) => handle.write(data));
    } finally {
      this.ptyOpening = false;
    }
    return { viewer, status: "spawned" };
  }

  private logPtyAudit(event: "spawn" | "attach" | "probe-none" | "detach" | "exit", cols: number, rows: number, code?: number | null): void {
    console.info(
      JSON.stringify({ pty: event, userId: this.row.user_id, sessionId: this.sessionId, kind: this.row.sandbox_kind, cols, rows, ...(code !== undefined ? { code } : {}), ts: Date.now() }),
    );
  }

  writePty(viewer: number, data: Uint8Array): void {
    if (viewer !== this.ptyViewer) return;
    this.ptyInput?.enqueue(data);
  }

  resizePty(viewer: number, cols: number, rows: number): void {
    if (viewer !== this.ptyViewer) return;
    void Promise.resolve(this.pty?.resize(cols, rows)).catch(() => {});
  }

  detachPty(viewer: number): void {
    if (viewer !== this.ptyViewer) return;
    this.logPtyAudit("detach", 0, 0);
    this.ptyViewer = 0;
    this.ptyClient = null;
    if (!this.pty || this.ptyGraceTimer) return;
    this.ptyGraceTimer = setTimeout(() => {
      this.ptyGraceTimer = null;
      if (this.ptyViewer === 0) {
        this.killPty();
        this.onPtyIdle?.();
      }
    }, PTY_GRACE_MS);
    this.ptyGraceTimer.unref?.();
  }

  hasLivePty(): boolean {
    return this.pty !== null;
  }

  private handlePtyExit(code: number | null): void {
    this.logPtyAudit("exit", 0, 0, code);
    this.ptyInput?.dispose();
    this.ptyInput = null;
    this.pty = null;
    this.ptyRing = [];
    this.ptyRingBytes = 0;
    this.ptyViewer = 0;
    if (this.ptyGraceTimer) {
      clearTimeout(this.ptyGraceTimer);
      this.ptyGraceTimer = null;
    }
    const client = this.ptyClient;
    this.ptyClient = null;
    client?.onExit(code);
    this.onPtyIdle?.();
  }

  private pushPtyRing(chunk: Uint8Array): void {
    const slice = chunk.length > PTY_RING_MAX_BYTES ? chunk.subarray(chunk.length - PTY_RING_MAX_BYTES) : chunk;
    this.ptyRing.push(slice);
    this.ptyRingBytes += slice.length;
    while (this.ptyRingBytes > PTY_RING_MAX_BYTES && this.ptyRing.length > 1) {
      this.ptyRingBytes -= this.ptyRing.shift()!.length;
    }
  }

  private killPty(): void {
    this.ptyGen++;
    if (this.ptyGraceTimer) {
      clearTimeout(this.ptyGraceTimer);
      this.ptyGraceTimer = null;
    }
    const h = this.pty;
    this.ptyInput?.dispose();
    this.ptyInput = null;
    this.pty = null;
    this.ptyClient = null;
    this.ptyViewer = 0;
    this.ptyRing = [];
    this.ptyRingBytes = 0;
    if (h) void Promise.resolve(h.kill()).catch(() => {});
  }

  pendingPermissionRequests(): PermissionRequestPayload[] {
    return [...this.pendingPermissions.values()].map((p) => p.request);
  }

  private nextSeq(): number {
    return ++this.timelineSeq;
  }

  private flushCapture(messageId: string, responseMsg?: unknown): void {
    if (!CAPTURE_RAW || this.closed) return;
    const pending = this.pendingCapture;
    if (!pending) return;
    this.pendingCapture = null;
    try {
      requestCaptureDao.append({
        session_id: this.sessionId,
        message_id: messageId,
        seq: this.nextSeq(),
        provider: this.row.provider,
        model: this.row.model,
        request_json: packCapture(pending.request),
        response_meta_json: pending.responseMeta ? JSON.stringify(pending.responseMeta) : null,
        response_msg_json: responseMsg !== undefined ? packCapture(responseMsg) : null,
        created_at: pending.requestTs,
      });
    } catch (e) {
      console.error("[agent-session] capture flush failed:", e instanceof Error ? e.message : e);
    }
  }

  private persist(item: TimelineItem, msgCut?: number): void {
    if (this.closed) return;
    timelineDao.append(this.sessionId, item, msgCut);
    this.notePersisted(item);
  }

  private notePersisted(item: TimelineItem): void {
    this.timelineVersion++;
    if (this.timelineCache !== null) {
      const index = this.timelineCacheIndex.get(item.seq);
      if (index === undefined) {
        this.timelineCacheIndex.set(item.seq, this.timelineCache.length);
        this.timelineCache.push(item);
      } else {
        this.timelineCache[index] = item;
      }
    }
  }

  private blocksFromAssistant(msg: AssistantMessage): AssistantBlock[] {
    return msg.content
      .map((c): AssistantBlock | null => {
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "thinking") return { type: "thinking", thinking: c.thinking };
        if (c.type === "toolCall") {
          const args = (c.arguments ?? {}) as Record<string, unknown>;
          const path = typeof args.path === "string" ? args.path : undefined;
          return { type: "toolCall", id: c.id, name: c.name, arguments: c.arguments, toolKind: toolKind(c.name), path };
        }
        return null;
      })
      .filter((b): b is AssistantBlock => b !== null);
  }

  isBusy(): boolean {
    return this.currentTurnId !== null || this.turnAbort !== null || this.status === "running";
  }

  hasBackgroundTasks(): boolean {
    return this.agentSupervisor?.hasBackgroundTasks() ?? false;
  }

  hasLiveAgentTasks(): boolean {
    return this.agentSupervisor?.hasLiveTasks() ?? false;
  }

  hasOpenAgentTasks(): boolean {
    return this.agentSupervisor?.hasActiveTasks() ?? false;
  }

  interruptDeletedOrchestrationTask(rootAgentId: string, taskId: string): boolean {
    if (this.closed || rootAgentId !== this.rootAgentId || !this.agentSupervisor) return false;
    const interrupted = this.agentSupervisor.interruptExternallySettledTask(taskId);
    this.agentSupervisor.poke();
    return interrupted;
  }

  retireBackgroundTasksForDrain(): void {
    void this.agentSupervisor?.close();
  }

  canSteer(): boolean {
    return this.isBusy() &&
      !this.closed &&
      !this.pendingMutationFaulted &&
      this.turnAcceptingSteer &&
      this.status === "running" &&
      !this.currentTurnFailed &&
      !this.turnAbort?.signal.aborted;
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  sendMessage(text: string, canvasState?: string, queuedPendingId?: string, authEpoch?: number): Promise<void> {
    return this.runTurn(text, canvasState, queuedPendingId, authEpoch, false);
  }

  retryModelResponse(authEpoch?: number): Promise<void> {
    return this.runTurn("", undefined, undefined, authEpoch, true);
  }

  beginInternalTeamTurn(input: TeamInternalTurnInput):
    | { accepted: false; reason: "busy" | "gated" | "draining" }
    | { accepted: true; completion: Promise<TeamInternalTurnResult> } {
    const session = sessionDao.byId(this.sessionId);
    if (
      !session
      || session.user_id !== this.userId
      || session.status === "closed"
      || input.task.userId !== this.userId
      || input.task.sessionId !== this.sessionId
      || input.task.kind !== "team_turn"
      || input.task.status !== "starting"
      || !input.task.teamId
      || input.task.leaseGeneration !== input.lease.taskGeneration
      || input.lease.claimGeneration < 1
      || input.deadlineAt <= Date.now()
    ) throw new Error("Team Turn admission does not match the owned target Session");
    const priorOutcome = teamTurnOutcomeDao.byTask(this.userId, input.task.id);
    if (priorOutcome) {
      if (
        priorOutcome.taskLeaseGeneration !== input.lease.taskGeneration
        || priorOutcome.mailClaimGeneration !== input.lease.claimGeneration
      ) throw new Error("Team Turn outcome does not match the active durable lease");
      return {
        accepted: true,
        completion: Promise.resolve({
          status: priorOutcome.status,
          completedAt: priorOutcome.createdAt,
          summary: priorOutcome.summary,
          body: priorOutcome.body,
          artifacts: priorOutcome.artifacts,
          usage: priorOutcome.usage,
        }),
      };
    }
    const priorTurn = agentTurnDao.byTeamTask(this.sessionId, input.task.id);
    if (priorTurn) {
      if (priorTurn.status === "in_progress") return { accepted: false, reason: "busy" };
      throw new Error("The prior Team Turn ended without a completion outbox");
    }
    if (this.queuedDrainSuspended) return { accepted: false, reason: "draining" };
    if (this.pendingMutationFaulted || executionDenial(this.userId)) {
      return { accepted: false, reason: "gated" };
    }
    if (this.hasOpenAgentTasks()) return { accepted: false, reason: "busy" };
    if (this.isBusy() || pendingMessageDao.listPending(this.sessionId).length > 0) {
      return { accepted: false, reason: "busy" };
    }
    return {
      accepted: true,
      completion: this.runTurn("", undefined, undefined, undefined, false, input),
    };
  }

  ownsInternalTeamTurn(taskId: string, turnId: string): boolean {
    return !this.closed
      && this.currentTeamTurnTaskId === taskId
      && this.currentTurnId === turnId;
  }

  private runTurn(
    text: string,
    canvasState: string | undefined,
    queuedPendingId: string | undefined,
    authEpoch: number | undefined,
    retryFromFailure: boolean,
    teamInput: TeamInternalTurnInput,
  ): Promise<TeamInternalTurnResult>;
  private runTurn(
    text: string,
    canvasState: string | undefined,
    queuedPendingId: string | undefined,
    authEpoch: number | undefined,
    retryFromFailure: boolean,
    teamInput?: undefined,
  ): Promise<void>;
  private runTurn(
    text: string,
    canvasState: string | undefined,
    queuedPendingId: string | undefined,
    authEpoch: number | undefined,
    retryFromFailure: boolean,
    teamInput?: TeamInternalTurnInput,
  ): Promise<void | TeamInternalTurnResult> {
    if (this.isBusy()) throw new Error("session is busy");
    if (this.pendingMutationFaulted) throw new Error(PENDING_MUTATION_FAILED_MESSAGE);
    if (teamInput && retryFromFailure) throw new Error("Team work cannot retry a prior user response");
    const retrySource = retryFromFailure ? this.agent.state.messages.at(-1) : undefined;
    if (
      retryFromFailure &&
      (!retrySource || retrySource.role !== "assistant" || retrySource.stopReason !== "error" ||
        !classifyError(retrySource.errorMessage).retryable)
    ) {
      throw new Error("the last model response is not retryable");
    }
    if (!teamInput && queuedPendingId && !pendingMessageDao.isPending(this.sessionId, queuedPendingId)) {
      return Promise.resolve();
    }
    const idleCompactionAtAdmission = this.idleCompaction;
    const turnId = teamInput?.turnId ?? "turn_" + crypto.randomUUID();
    this.currentTurnId = turnId;
    this.currentTurnFailed = false;
    const startedAt = Date.now();
    const teamMessage: TeamAssignmentMessage | null = teamInput ? {
      role: "teamAssignment",
      taskId: teamInput.task.id,
      title: teamInput.task.title,
      assignment: teamInput.assignment,
      deadlineAt: teamInput.deadlineAt,
      budget: teamInput.budget,
      timestamp: startedAt,
    } : null;
    const teamAssignmentItem: TimelineItem | null = teamInput ? {
      kind: "team_assignment",
      id: "team_assignment_" + crypto.randomUUID(),
      seq: this.nextSeq(),
      taskId: teamInput.task.id,
      title: teamInput.task.title,
      ts: startedAt,
      turnId,
    } : null;
    const configured = sessionDao.byId(this.sessionId);
    const turnProvider = configured?.provider ?? this.row.provider;
    const turnModel = configured?.model ?? this.row.model;
    const turnModelInfo = resolveModel(turnProvider, turnModel);
    const turnThinkingLevel = effectiveThinkingLevel(turnModelInfo, configured?.thinking_level);
    this.turnFirstTokenAt = null;
    this.overflowRetryAttempted = false;
    this.overflowRecoveryPending = false;
    this.modelRetries = 0;
    this.retryPending = false;
    this.lastModelRetryKind = null;
    this.modelRetryRecoveryLogged = false;
    this.currentTeamTurnTaskId = teamInput?.task.id ?? null;
    this.currentTeamAttempt = teamInput ? {
      taskGeneration: teamInput.lease.taskGeneration,
      mailId: teamInput.lease.mailId,
      claimToken: teamInput.lease.claimToken,
      claimGeneration: teamInput.lease.claimGeneration,
      deadlineAt: teamInput.deadlineAt,
    } : null;
    this.currentTeamInterruption = null;
    this.currentTeamTokenReservations = [];
    if (!retryFromFailure) this.recapLastUserText = teamInput ? "" : text;
    this.recapLastAssistantText = "";
    this.recapActivity = [];
    this.modelRoundOrdinal = 0;
    this.modelRoundStartedAt = null;
    this.toolArgumentsStartedAt.clear();
    this.toolArgumentsReadyAt.clear();
    this.toolDispatchedAt.clear();
    this.proposedToolCalls.clear();
    this.deniedCalls.clear();
    try {
      runInImmediateTransaction(() => {
        assertAuthEpochInWriterTransaction(this.userId, authEpoch);
        const denial = executionDenial(this.userId);
        if (denial) throw new Error(denial.message);
        if (queuedPendingId && !pendingMessageDao.isPending(this.sessionId, queuedPendingId)) {
          throw new Error("queued input was removed");
        }
        agentTurnDao.start({
          id: turnId,
          sessionId: this.sessionId,
          startedAt,
          provider: turnProvider,
          model: turnModel,
          ...(teamInput
            ? {
                source: "team" as const,
                teamTaskId: teamInput.task.id,
                teamTaskLeaseGeneration: teamInput.lease.taskGeneration,
                teamMailClaimGeneration: teamInput.lease.claimGeneration,
              }
            : retryFromFailure
              ? { source: "user" as const }
              : { source: "user" as const, acceptedInput: text }),
        });
        if (teamAssignmentItem) timelineDao.append(this.sessionId, teamAssignmentItem);
        if (teamInput) recapJobDao.delete(this.sessionId);
        sessionDao.setStatus(this.sessionId, "running");
      });
    } catch (error) {
      this.currentTurnId = null;
      this.currentTurnExecution = null;
      this.currentTeamTurnTaskId = null;
      this.currentTeamAttempt = null;
      this.currentQueuedPendingId = null;
      this.currentQueuedPendingClaimed = false;
      this.turnAcceptingSteer = false;
      throw error;
    }
    this.currentTurnExecution = {
      provider: turnProvider,
      model: turnModel,
      thinkingLevel: turnThinkingLevel,
    };
    this.currentQueuedPendingId = queuedPendingId ?? null;
    this.currentQueuedPendingClaimed = false;
    if (teamAssignmentItem) this.notePersisted(teamAssignmentItem);
    const turn = new AbortController();
    this.turnAbort = turn;
    this.turnAcceptingSteer = !teamInput;
    return (async () => {
    const abortTeamTurn = () => {
      const reason = teamInput?.signal.reason;
      this.currentTeamInterruption = {
        origin: "system",
        reason: reason instanceof Error
          ? reason.message
          : typeof reason === "string" && reason
            ? reason
            : "Team Turn interrupted by its execution fence.",
      };
      turn.abort(teamInput?.signal.reason);
      this.agent.abort();
      for (const [requestId, permission] of this.pendingPermissions) {
        permission.resolve("turn_aborted");
        this.pendingPermissions.delete(requestId);
      }
    };
    let failed = false;
    let internalResult: TeamInternalTurnResult | undefined;
    let teamPromptStarted = false;
    let userPersisted = retryFromFailure || Boolean(teamInput);
    let queuedCancelled = false;
    const persistAcceptedUser = (msgCut: number): boolean => {
      if (userPersisted) return true;
      const item: TimelineItem = {
        kind: "user",
        id: "u_" + crypto.randomUUID(),
        seq: this.nextSeq(),
        text,
        ts: Date.now(),
        turnId,
      };
      let consumedQueuedHere = false;
      const committed = runInTransaction(() => {
        if (queuedPendingId && !this.currentQueuedPendingClaimed) {
          if (!pendingMessageDao.markConsumed(this.sessionId, queuedPendingId)) return false;
          consumedQueuedHere = true;
        }
        timelineDao.append(this.sessionId, item, msgCut);
        agentTurnDao.clearAcceptedInput(this.sessionId, turnId);
        return true;
      });
      if (!committed) return false;
      this.notePersisted(item);
      this.pendingUserItem = item;
      userPersisted = true;
      if (consumedQueuedHere) {
        this.pendingQueueChanged();
        this.emitPendingQueue();
      }
      this.emitAgent({ t: "user_message", id: item.id, text, seq: item.seq, turnId });
      return true;
    };
    let compactedThisTurn = false;
    try {
      if (teamInput) {
        if (teamInput.signal.aborted) abortTeamTurn();
        else teamInput.signal.addEventListener("abort", abortTeamTurn, { once: true });
      }
      this.hintAgentSupervisor("turn_start");
      this.setStatus("running", false);
      this.recapTurnId = teamInput ? null : turnId;
      if (teamAssignmentItem) {
        this.emitAgent({
          t: "team_assignment",
          id: teamAssignmentItem.id,
          seq: teamAssignmentItem.seq,
          taskId: teamAssignmentItem.taskId,
          title: teamAssignmentItem.title,
          ts: teamAssignmentItem.ts,
          turnId,
        });
      }
      this.emitAgent({ t: "turn_start", turnId, startedAt });
      logAudit("turn_start", {
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          turnId,
          mode: this.row.mode,
          sandboxKind: this.row.sandbox_kind,
          provider: turnProvider,
          model: turnModel,
          promptBytes: Buffer.byteLength(
            teamMessage ? String(convertTeamMessageToLlm(teamMessage)[0]?.content ?? "") : text,
            "utf8",
          ),
          retryFromFailure,
        },
      });
      this.toolStartedAt.clear();
      if (retrySource) {
        const messages = this.agent.state.messages;
        if (messages.at(-1) !== retrySource) throw new Error("the failed model response changed before retry");
        this.agent.state.messages = messages.slice(0, -1);
      }
      if (idleCompactionAtAdmission) {
        await idleCompactionAtAdmission;
        if (turn.signal.aborted) {
          if (teamInput) throw turn.signal.reason ?? new Error("Team Turn was interrupted before setup");
          return;
        }
      }
      const toolSetup = await awaitSetupOrAbort(this.ensureTools(), turn.signal);
      if (!toolSetup.completed) {
        if (teamInput) throw turn.signal.reason ?? new Error("Team Turn was interrupted during tool setup");
        return;
      }
      {
        if (configured) {
          if (turnProvider !== this.row.provider || turnModel !== this.row.model) {
            const m = resolveModel(turnProvider, turnModel);
            this.model = m;
            this.agent.state.model = m;
            this.row.provider = turnProvider;
            this.row.model = turnModel;
          }
          this.agent.state.thinkingLevel = effectiveThinkingLevel(this.model, configured.thinking_level);
          if (configured.approval_policy === "untrusted" && this.row.approval_policy !== "untrusted") {
            this.sessionApproved.clear();
          }
          this.row.approval_policy = configured.approval_policy;
        }
      }
      {
        const memoryBlock = userMemoryPromptBlock(this.row.user_id);
        this.agent.state.systemPrompt = memoryBlock
          ? `${this.systemPrompt}

---

${memoryBlock}`
          : this.systemPrompt;
      }
      this.effectiveSystemPrompt = await this.promptWithAgentRoster(this.agent.state.systemPrompt);
      const pendingTeamMessages = teamMessage ? convertTeamMessageToLlm(teamMessage) : [];
      const teamBudgetPressure = teamInput && teamMessage
        ? await this.providerInputUpperBound(
            this.effectiveSystemPrompt,
            [
              ...convertTeamMessagesToLlm(this.agent.state.messages),
              ...pendingTeamMessages,
            ],
            this.agent.state.tools ?? [],
          ) + TEAM_PROVIDER_MIN_OUTPUT_TOKENS > teamInput.budget.maxTokens
        : false;
      compactedThisTurn = await this.maybeCompact(
        turn.signal,
        teamBudgetPressure,
        teamBudgetPressure && teamInput
          ? {
              maxInputTokens: teamInput.budget.maxTokens - TEAM_PROVIDER_MIN_OUTPUT_TOKENS,
              appendedMessages: pendingTeamMessages,
              phase: "team_budget_fit",
            }
          : undefined,
      );
      if (turn.signal.aborted) {
        if (teamInput) throw turn.signal.reason ?? new Error("Team Turn was interrupted during context preparation");
        return;
      }
      if (retryFromFailure) {
        await this.agent.continue();
      } else if (teamMessage) {
        teamPromptStarted = true;
        await this.agent.prompt(teamMessage);
      } else {
      if (queuedPendingId && !pendingMessageDao.isPending(this.sessionId, queuedPendingId)) {
        queuedCancelled = true;
        turn.abort();
        return;
      }
      this.pendingUserMsgCut = this.agent.state.messages.length;
      if (!persistAcceptedUser(this.pendingUserMsgCut)) {
        queuedCancelled = true;
        turn.abort();
        return;
      }
      await this.agent.prompt(canvasBlock(canvasState) + text + timeBlock());
      }
      if (this.overflowRecoveryPending && !this.overflowRetryAttempted) {
        this.overflowRetryAttempted = true;
        this.overflowRecoveryPending = false;
        const attempt = this.currentTeamAttempt;
        const remaining = teamInput && attempt && this.currentTeamTurnTaskId
          ? teamTaskDao.remainingProviderBudget({
              userId: this.userId,
              taskId: this.currentTeamTurnTaskId,
              expectedTaskLeaseGeneration: attempt.taskGeneration,
              mailId: attempt.mailId,
              claimToken: attempt.claimToken,
              claimGeneration: attempt.claimGeneration,
              at: Date.now(),
            })
          : undefined;
        const teamRetryUnavailable = Boolean(
          teamInput
          && (
            !remaining
            || remaining.maxModelCycles < 1
            || remaining.maxTokens <= TEAM_PROVIDER_MIN_OUTPUT_TOKENS
          ),
        );
        const compacted = teamRetryUnavailable
          ? false
          : await this.maybeCompact(
              turn.signal,
              true,
              remaining
                ? {
                    maxInputTokens: remaining.maxTokens - TEAM_PROVIDER_MIN_OUTPUT_TOKENS,
                    phase: "post_overflow_retry",
                  }
                : undefined,
            );
        compactedThisTurn ||= compacted;
        if (turn.signal.aborted) {
          if (teamInput) throw turn.signal.reason ?? new Error("Team Turn was interrupted during overflow recovery");
          return;
        }
        if (compacted) {
          await this.agent.continue();
        } else {
          failed = true;
          const recoveryUsage = this.getContextUsage();
          logAudit("compaction_failed", {
            level: "warn",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: {
              turnId,
              phase: "post_overflow_unrecovered",
              ctxUsed: recoveryUsage.used,
              ctxWindow: recoveryUsage.total,
            },
          });
          this.emitTurnError(this.describeError("the conversation is too large for this model's context window — start a new session or switch to a larger-context model"));
        }
      }
      while (this.retryPending && !turn.signal.aborted) {
        this.retryPending = false;
        await new Promise((r) => setTimeout(r, modelRetryBackoffMs(this.modelRetries)));
        if (turn.signal.aborted) break;
        await this.agent.continue();
      }
    } catch (e) {
      failed = !turn.signal.aborted;
      if (!userPersisted && !this.closed) {
        if (!persistAcceptedUser(this.agent.state.messages.length)) queuedCancelled = Boolean(queuedPendingId);
      }
      this.terminalizeUndispatchedTools(
        turn.signal.aborted ? "cancelled" : "error",
        turn.signal.aborted
          ? "Interrupted before this tool could run."
          : "The model response failed before this tool could run.",
      );
      if (turn.signal.aborted) {
        logAudit("turn_interrupted", {
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { turnId, phase: "thrown_abort", errorKind: errorKind(e) },
        });
      } else {
        console.error("[agent-session] turn failed:", e instanceof Error ? e.stack ?? e.message : e);
        logAudit("turn_error", {
          level: "error",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { turnId, errorKind: errorKind(e), raw: rawErrorText(e) },
        });
        this.emitTurnError(this.describeError(e), { flushCapture: true });
      }
    } finally {
      try {
        if (teamInput) teamInput.signal.removeEventListener("abort", abortTeamTurn);
        this.turnAcceptingSteer = false;
        this.turnAbort = null;
        if (!userPersisted && !queuedCancelled && !this.closed) {
          if (!persistAcceptedUser(this.agent.state.messages.length)) queuedCancelled = Boolean(queuedPendingId);
        }
        if (queuedCancelled) {
          agentTurnDao.clearAcceptedInput(this.sessionId, turnId);
        }
        this.pendingUserItem = null;
        this.pendingUserMsgCut = null;
        if (
          teamMessage && teamPromptStarted
          && !this.agent.state.messages.some((message) =>
            message.role === "teamAssignment" && message.taskId === teamMessage.taskId
          )
        ) {
          this.agent.state.messages = [...this.agent.state.messages, teamMessage];
        }
        if (!this.closed) {
          runInTransaction(() => {
            messageDao.replaceAll(this.sessionId, this.agent.state.messages);
            sessionDao.touch(this.sessionId);
          });
          this.schedulePersistedResultAcks();
        }
        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        const turnFailed = failed || this.currentTurnFailed || this.status === "error";
        const turnStatus: AgentTurnStatus = turnFailed
          ? "failed"
          : turn.signal.aborted
            ? "interrupted"
            : "completed";
        if (this.proposedToolCalls.size > 0) {
          this.terminalizeUndispatchedTools(
            turnStatus === "failed" ? "error" : "cancelled",
            turnStatus === "failed"
              ? "The model response failed before this tool could run."
              : "The turn ended before this tool could run.",
          );
        }
        if (sessionDao.byId(this.sessionId)) {
          if (teamInput) {
            const turnItems = timelineDao.list(this.sessionId).filter((item) => item.turnId === turnId);
            const assistants = turnItems.filter(
              (item): item is Extract<TimelineItem, { kind: "assistant" }> => item.kind === "assistant",
            );
            const assistantText = assistants.flatMap((item) => item.blocks)
              .filter((block): block is Extract<AssistantBlock, { type: "text" }> => block.type === "text")
              .map((block) => block.text)
              .join("\n\n")
              .trim();
            const teamInterruption = this.currentTeamInterruption as {
              origin: "user" | "system";
              reason: string;
            } | null;
            const outcomeStatus: TeamInternalTurnResult["status"] = turnStatus === "completed"
              ? "completed"
              : turnStatus === "failed"
                ? "failed"
                : teamInterruption?.origin === "system" || this.closed
                  ? "interrupted"
                  : "cancelled";
            const terminalReason = outcomeStatus === "cancelled"
              ? teamInterruption?.reason ?? "Team Turn cancelled by the user."
              : outcomeStatus === "interrupted"
                ? teamInterruption?.reason ?? "Team Turn interrupted by the system."
                : undefined;
            const summary = truncateUtf8(
              (terminalReason ?? assistantText) || (
                outcomeStatus === "completed"
                  ? "Team Turn completed without assistant text."
                  : `Team Turn ${outcomeStatus}.`
              ),
              15 * 1024,
            );
            const artifacts = collectTeamArtifacts(turnItems);
            let durableOutcome = teamTurnOutcomeDao.byTask(this.userId, teamInput.task.id);
            if (!durableOutcome) {
              const exactLease = teamTaskDao.attemptMatches(
                this.userId,
                teamInput.task.id,
                teamInput.lease.taskGeneration,
                teamInput.lease.claimGeneration,
              );
              if (exactLease) {
                runInTransaction(() => {
                  agentTurnDao.complete(this.sessionId, turnId, turnStatus, completedAt);
                  teamTurnOutcomeDao.record({
                    taskId: teamInput.task.id,
                    userId: this.userId,
                    sessionId: this.sessionId,
                    turnId,
                    taskLeaseGeneration: teamInput.lease.taskGeneration,
                    mailClaimGeneration: teamInput.lease.claimGeneration,
                    status: outcomeStatus,
                    summary,
                    body: {
                      terminalStatus: outcomeStatus,
                      ...(terminalReason ? { reason: terminalReason } : {}),
                    },
                    artifacts,
                    at: completedAt,
                  });
                });
              } else {
                agentTurnDao.complete(this.sessionId, turnId, "interrupted", completedAt);
                internalResult = {
                  status: "interrupted",
                  completedAt,
                  summary: "Team Turn lost its durable execution lease.",
                  body: { terminalStatus: "interrupted", reason: "lease_lost" },
                  artifacts,
                  usage: teamTaskDao.usageByTask(this.userId, teamInput.task.id),
                };
              }
              durableOutcome = teamTurnOutcomeDao.byTask(this.userId, teamInput.task.id);
            } else {
              agentTurnDao.complete(this.sessionId, turnId, turnStatus, completedAt);
            }
            if (durableOutcome) {
              internalResult = {
                status: durableOutcome.status,
                completedAt: durableOutcome.createdAt,
                summary: durableOutcome.summary,
                body: durableOutcome.body,
                artifacts: durableOutcome.artifacts,
                usage: durableOutcome.usage,
              };
            } else if (!internalResult) {
              throw new Error("Team Turn completion outbox was not stored");
            }
          } else {
            agentTurnDao.complete(this.sessionId, turnId, turnStatus, completedAt);
          }
        }
        this.emitAgent({ t: "turn_end", turnId, status: turnStatus, completedAt, durationMs });
        if (turnStatus !== "failed" && this.status !== "error") this.setStatus("idle");
        logAudit("turn_end", {
          level: turnStatus === "failed" ? "warn" : "info",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            turnId,
            status: turnStatus,
            sessionStatus: this.status,
            durationMs,
            ttftMs: this.turnFirstTokenAt !== null ? this.turnFirstTokenAt - startedAt : null,
            compactedThisTurn,
            modelRetryAttempts: this.modelRetries,
            modelRetryRecovered: this.modelRetryRecoveryLogged,
          },
        });
        if (!turn.signal.aborted || turnStatus === "failed") {
          const ok = turnStatus === "completed";
          recordTurnPerf({
            provider: turnProvider,
            model: turnModel,
            ttftMs: ok && this.turnFirstTokenAt !== null ? this.turnFirstTokenAt - startedAt : null,
            totalMs: durationMs,
            ok,
          });
        }
      } catch (finalizationError) {
        if (teamInput && sessionDao.byId(this.sessionId)) {
          runInTransaction(() => {
            agentTurnDao.complete(this.sessionId, turnId, "interrupted", Date.now());
            sessionDao.setStatus(this.sessionId, "idle");
          });
          this.setStatus("idle", false);
        }
        throw finalizationError;
      } finally {
        this.currentQueuedPendingId = null;
        this.currentQueuedPendingClaimed = false;
        this.currentTurnExecution = null;
        this.currentTurnId = null;
        this.currentTeamTurnTaskId = null;
        this.currentTeamAttempt = null;
        this.currentTeamInterruption = null;
        if (!teamInput && !this.closed && !turn.signal.aborted && this.status === "idle") this.maybeCompactIdle();
        this.scheduleQueuedTurns();
      }
    }
    if (teamInput) {
      if (!internalResult) throw new Error("Team Turn ended without a durable completion outcome");
      return internalResult;
    }
    })();
  }

  private scheduleQueuedTurns(): void {
    if (
      this.closed ||
      this.queuedDrainSuspended ||
      this.isBusy() ||
      this.queuedDrainRunning ||
      this.queuedDrainScheduled
    ) return;
    if (!pendingMessageDao.listPending(this.sessionId).some((message) => message.kind === "queue")) return;
    this.queuedDrainScheduled = true;
    queueMicrotask(() => {
      this.queuedDrainScheduled = false;
      void this.drainQueuedTurns();
    });
  }

  private async drainQueuedTurns(): Promise<void> {
    if (this.closed || this.queuedDrainSuspended || this.isBusy() || this.queuedDrainRunning) return;
    this.queuedDrainRunning = true;
    try {
      while (!this.closed && !this.queuedDrainSuspended && !this.isBusy()) {
        const next = pendingMessageDao.listPending(this.sessionId).find((message) => message.kind === "queue");
        if (!next) break;
        try {
          await this.sendMessage(next.text, undefined, next.id);
        } catch (error) {
          logAudit("queued_turn_start_failed", {
            level: "warn",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: { errorKind: errorKind(error) },
          });
          break;
        }
        if (pendingMessageDao.isPending(this.sessionId, next.id)) break;
      }
    } finally {
      this.queuedDrainRunning = false;
    }
  }

  suspendQueuedTurnsForDrain(): void {
    this.queuedDrainSuspended = true;
  }

  private async compactBetweenRounds(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.closed || this.compactionInFlight) return;
    const usage = this.getContextUsage();
    if (!usage.compactAt || usage.measured <= 0 || usage.used < usage.compactAt) return;
    const before = usage.used;
    const compacted = await this.maybeCompact(signal);
    if (!compacted) return;
    logAudit("compaction_between_rounds", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: {
        turnId: this.currentTurnId,
        modelRound: this.modelRoundOrdinal,
        ctxBefore: before,
        ctxAfter: this.getContextUsage().used,
        ctxWindow: usage.total,
      },
    });
  }

  private maybeCompactIdle(): void {
    if (this.closed || this.isBusy() || this.idleCompaction || this.compactionInFlight) return;
    const usage = this.getContextUsage();
    if (!usage.compactAt || usage.used < usage.compactAt) return;
    this.idleCompaction = (async () => {
      try {
        const compacted = await this.maybeCompact(undefined);
        if (compacted && !this.closed) {
          messageDao.replaceAll(this.sessionId, this.agent.state.messages as Message[]);
          sessionDao.touch(this.sessionId);
        }
      } catch {
      } finally {
        this.idleCompaction = null;
      }
    })();
  }

  steer(text: string, authEpoch?: number): Promise<void> {
    if (this.canSteer()) {
      const result = this.appendPending("steer", text, authEpoch);
      if (!result.ok) throw new RuntimeMutationRejectedError(result);
      return Promise.resolve();
    }
    if (this.isBusy()) {
      return this.queueFollowUp(text, authEpoch);
    }
    return this.sendMessage(text, undefined, undefined, authEpoch);
  }

  queueFollowUp(text: string, authEpoch?: number): Promise<void> {
    if (this.isBusy()) {
      const result = this.appendPending("queue", text, authEpoch);
      if (!result.ok) throw new RuntimeMutationRejectedError(result);
      return Promise.resolve();
    }
    return this.sendMessage(text, undefined, undefined, authEpoch);
  }

  clearPending(pendingId: string, authEpoch?: number): PendingMutationResult {
    const outcome = this.applyPendingMutation("clear", authEpoch, (current) => {
      const pending = current.find((message) => message.id === pendingId);
      if (!pending) return { state: "noop" };
      const activeQueuedTurn = pending.kind === "queue" &&
        pending.id === this.currentQueuedPendingId && this.currentTurnId !== null;
      if (!pendingMessageDao.deleteById(this.sessionId, pendingId)) return { state: "noop" };
      let reclassifiedSteers = 0;
      if (activeQueuedTurn) {
        agentTurnDao.clearAcceptedInput(this.sessionId, this.currentTurnId!);
        reclassifiedSteers = pendingMessageDao.reclassifyPendingKind(this.sessionId, "steer", "queue");
      }
      return {
        state: "changed",
        value: { pending, activeQueuedTurn, reclassifiedSteers },
        rebuildSteering: pending.kind === "steer" || activeQueuedTurn,
      };
    });
    if (outcome.state === "failed" || outcome.state === "denied") return outcome.result;
    if (outcome.state === "noop") return { ok: true };
    const { activeQueuedTurn, reclassifiedSteers } = outcome.value!;
    if (activeQueuedTurn) {
      this.turnAcceptingSteer = false;
      this.turnAbort?.abort();
      this.agent.abort();
    }
    if (activeQueuedTurn && reclassifiedSteers > 0) {
      logAudit("pending_steer_requeued", {
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: { turnId: this.currentTurnId, reason: "active_queue_removed", count: reclassifiedSteers },
      });
    }
    return { ok: true };
  }

  setPendingKind(pendingId: string, kind: PendingMessage["kind"], authEpoch?: number): PendingMutationResult {
    const outcome = this.applyPendingMutation("kind", authEpoch, (current) => {
      const pending = current.find((message) => message.id === pendingId);
      if (!pending || pending.kind === kind ||
          (pending.kind === "queue" && pending.id === this.currentQueuedPendingId && this.currentTurnId !== null)) {
        return { state: "noop" };
      }
      if (kind === "steer" && !this.canSteer()) return { state: "noop" };
      if (kind === "steer") {
        const denied = this.pendingSteerMutationDenial();
        if (denied) return { state: "denied", result: denied };
      }
      if (!pendingMessageDao.setKindById(this.sessionId, pendingId, kind)) return { state: "noop" };
      return { state: "changed", value: pending, rebuildSteering: true };
    });
    if (outcome.state === "failed" || outcome.state === "denied") return outcome.result;
    if (outcome.state === "noop") return { ok: true };
    logAudit("pending_kind_swapped", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { pendingId, from: outcome.value!.kind, to: kind },
    });
    return { ok: true };
  }

  setPendingText(pendingId: string, text: string, authEpoch?: number): PendingMutationResult {
    const trimmed = text.trim();
    const outcome = this.applyPendingMutation("text", authEpoch, (current) => {
      const pending = current.find((message) => message.id === pendingId);
      if (!pending || !trimmed || trimmed === pending.text || trimmed.length > 32_000 ||
          (pending.kind === "queue" && pending.id === this.currentQueuedPendingId && this.currentTurnId !== null)) {
        return { state: "noop" };
      }
      if (pending.kind === "steer") {
        const denied = this.pendingSteerMutationDenial();
        if (denied) return { state: "denied", result: denied };
      }
      if (!pendingMessageDao.setTextById(this.sessionId, pendingId, trimmed)) return { state: "noop" };
      return { state: "changed", value: pending, rebuildSteering: pending.kind === "steer" };
    });
    if (outcome.state === "failed" || outcome.state === "denied") return outcome.result;
    if (outcome.state === "noop") return { ok: true };
    logAudit("pending_edited", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { pendingId, kind: outcome.value!.kind, fromLength: outcome.value!.text.length, toLength: trimmed.length },
    });
    return { ok: true };
  }

  reorderPending(order: string[], authEpoch?: number): PendingMutationResult {
    const outcome = this.applyPendingMutation("order", authEpoch, (current) => {
      const currentIds = new Set(current.map((pending) => pending.id));
      const validOrder = current.length === order.length && new Set(order).size === order.length &&
        order.every((id) => currentIds.has(id));
      if (!validOrder) return { state: "noop" };
      const claimedIndex = this.currentTurnId !== null && this.currentQueuedPendingId !== null
        ? current.findIndex((pending) => pending.id === this.currentQueuedPendingId)
        : -1;
      if (claimedIndex >= 0 && current.slice(0, claimedIndex + 1)
        .some((pending, index) => order[index] !== pending.id)) return { state: "noop" };
      const byId = new Map(current.map((pending) => [pending.id, pending]));
      const currentSteers = current.filter((pending) => pending.kind === "steer").map((pending) => pending.id);
      const reorderedSteers = order.filter((id) => byId.get(id)?.kind === "steer");
      const steerOrderChanged = currentSteers.some((id, index) => reorderedSteers[index] !== id);
      if (steerOrderChanged) {
        const denied = this.pendingSteerMutationDenial();
        if (denied) return { state: "denied", result: denied };
      }
      if (!pendingMessageDao.reorderPendingInTransaction(this.sessionId, order)) return { state: "noop" };
      return { state: "changed", value: undefined, rebuildSteering: steerOrderChanged };
    });
    if (outcome.state === "failed" || outcome.state === "denied") return outcome.result;
    if (outcome.state === "noop") return { ok: true };
    logAudit("pending_reordered", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { count: order.length },
    });
    return { ok: true };
  }

  private appendPending(kind: PendingMessage["kind"], text: string, authEpoch?: number): PendingMutationResult {
    const outcome = this.applyPendingMutation(`append_${kind}`, authEpoch, () => {
      const denied = this.pendingSteerMutationDenial();
      if (denied) return { state: "denied", result: denied };
      pendingMessageDao.append(this.sessionId, {
        id: "p_" + crypto.randomUUID(), kind, text, ts: Date.now(),
      });
      return { state: "changed", value: undefined, rebuildSteering: kind === "steer" };
    });
    return outcome.state === "failed" || outcome.state === "denied" ? outcome.result : { ok: true };
  }

  private applyPendingMutation<T>(
    operation: "append_steer" | "append_queue" | "clear" | "kind" | "text" | "order",
    authEpoch: number | undefined,
    mutate: (current: PendingMessage[]) => PendingMutationTxnOutcome<T>,
  ): PendingMutationOutcome<T> {
    if (this.pendingMutationFaulted) {
      const result = { ok: false, code: "pending_mutation_failed", message: PENDING_MUTATION_FAILED_MESSAGE } as const;
      try { this.emitPendingQueue(); } catch {  }
      return { state: "failed", result };
    }
    let prior: PendingMessage[] | null = null;
    let piRebuildStarted = false;
    let outcome: PendingMutationTxnOutcome<T>;
    try {
      outcome = runInImmediateTransaction(() => {
        assertAuthEpochInWriterTransaction(this.userId, authEpoch);
        const current = pendingMessageDao.listPending(this.sessionId);
        prior = current;
        const next = mutate(current);
        if (next.state === "changed" && next.rebuildSteering) {
          piRebuildStarted = true;
          this.rebuildSteeringQueue(pendingMessageDao.listPending(this.sessionId));
        }
        return next;
      });
    } catch (error) {
      let restored = true;
      let durable: PendingMessage[] | null = null;
      try { durable = pendingMessageDao.listPending(this.sessionId); } catch { restored = false; }
      if (restored && prior && durable && !samePendingSnapshot(prior, durable)) {
        this.pendingQueueChanged();
        return { state: "failed", result: this.failClosedPendingMutation(operation, error) };
      }
      if (restored && piRebuildStarted && durable) {
        try { this.rebuildSteeringQueue(durable); } catch { restored = false; }
      }
      const result: PendingMutationDenial = error instanceof AuthEpochRevokedError
        ? { ok: false, code: "auth_revoked", message: AUTH_EPOCH_REVOKED_MESSAGE }
        : { ok: false, code: "pending_mutation_failed", message: PENDING_MUTATION_FAILED_MESSAGE };
      if (restored) {
        try { this.emitPendingQueue(); } catch { restored = false; }
      }
      if (!restored) return { state: "failed", result: this.failClosedPendingMutation(operation, error) };
      this.auditPendingMutationDenial(operation, result, false);
      return { state: "failed", result };
    }
    if (outcome.state === "changed") this.pendingQueueChanged();
    this.emitPendingQueue();
    if (outcome.state === "denied") this.auditPendingMutationDenial(operation, outcome.result, false);
    return outcome;
  }

  private failClosedPendingMutation(operation: string, cause: unknown): PendingMutationDenial {
    this.pendingMutationFaulted = true;
    this.turnAcceptingSteer = false;
    this.queuedDrainSuspended = true;
    try { this.agent.clearAllQueues(); } catch {  }
    try { this.turnAbort?.abort(); } catch {  }
    try { this.agent.abort(); } catch {  }
    let durableReady = false;
    let reclassified = 0;
    try {
      reclassified = runInImmediateTransaction(() =>
        pendingMessageDao.reclassifyPendingKind(this.sessionId, "steer", "queue"));
      durableReady = true;
      if (reclassified > 0) this.pendingQueueChanged();
      this.emitPendingQueue();
    } catch {  }
    const result = { ok: false, code: "pending_mutation_failed", message: PENDING_MUTATION_FAILED_MESSAGE } as const;
    this.auditPendingMutationDenial(operation, result, true, cause);
    if (durableReady) queueMicrotask(() => this.onIsolationRequired?.());
    return result;
  }

  private auditPendingMutationDenial(
    operation: string,
    result: PendingMutationDenial,
    isolated: boolean,
    cause?: unknown,
  ): void {
    logAudit("pending_mutation_denied", {
      level: "warn",
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { operation, reason: result.code, isolated, ...(cause ? { errorKind: errorKind(cause) } : {}) },
    });
  }

  private rebuildSteeringQueue(pending = pendingMessageDao.listPending(this.sessionId)): void {
    this.agent.clearSteeringQueue();
    for (const remaining of pending) {
      if (remaining.kind === "steer") {
        this.agent.steer({ role: "user", content: remaining.text, timestamp: remaining.ts });
      }
    }
  }

  private pendingSteerMutationDenial(): PendingMutationDenial | null {
    const denial = runtimeExecutionDenial(this.userId, this.queuedDrainSuspended);
    return denial ? { ok: false, code: denial.kind, message: denial.message } : null;
  }

  private describeError(e: unknown): { message: string; errorKind: string; retryable: boolean } {
    const { errorKind, retryable } = classifyError(e);
    const raw = errorMessage(e);
    const message = ERROR_UI_MESSAGES[errorKind] ?? (raw.length > 300 ? raw.slice(0, 300) + "…" : raw || "The turn failed for an unknown reason.");
    return { message, errorKind, retryable };
  }

  private emitTurnError(desc: { message: string; errorKind: string; retryable: boolean }, opts?: { flushCapture?: boolean }): void {
    this.currentTurnFailed = true;
    this.requeueUndeliveredSteers("turn_failure");
    const err: TimelineItem = {
      kind: "error",
      id: "e_" + crypto.randomUUID(),
      seq: this.nextSeq(),
      message: desc.message,
      ts: Date.now(),
      errorKind: desc.errorKind,
      retryable: desc.retryable,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
    };
    this.persist(err);
    if (opts?.flushCapture) this.flushCapture(err.id);
    this.emitAgent({ t: "error", message: desc.message, errorKind: desc.errorKind, retryable: desc.retryable, turnId: this.currentTurnId ?? undefined });
    this.setStatus("error");
  }

  private async maybeCompact(
    signal?: AbortSignal,
    force = false,
    fit?: Readonly<{
      maxInputTokens: number;
      appendedMessages?: Context["messages"];
      phase: "team_budget_fit" | "post_overflow_retry";
    }>,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.compactionInFlight) return false;
    const contextWindow = (this.model as { contextWindow?: number }).contextWindow ?? 0;
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: this.compactionReserveTokens() };
    if (!settings.enabled || !contextWindow) return false;
    const usage = this.getContextUsage();
    const ESTIMATE_BIAS = 1.05;
    const contextTokens =
      usage.measured === 0
        ? Math.ceil((usage.used + usage.parts.system + usage.parts.tools) * ESTIMATE_BIAS)
        : usage.used;
    const compactionPhase = fit?.phase ?? (force ? "post_overflow_retry" : "proactive");
    if (!force && !shouldCompact(contextTokens, contextWindow, settings) && contextTokens < this.compactTriggerAt()) {
      return false;
    }
    const messages = this.agent.state.messages as AgentMessage[];
    if (messages.length < 4) return false;

    let cut = messages.length;
    if (fit) {
      if (!Number.isSafeInteger(fit.maxInputTokens) || fit.maxInputTokens < 1) return false;
      const boundaries: number[] = [];
      for (let i = 1; i < messages.length; i++) {
        if (isAgentPromptBoundary(messages[i]!)) boundaries.push(i);
      }
      if (boundaries.length === 0) return false;
      const plannedSummary: Message = {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX} The earlier part of this conversation was compacted to fit the model's context window. Summary of what happened so far:\n\n${"x".repeat(COMPACTION_SUMMARY_OUTPUT_CTX * 4)}`,
        timestamp: Date.now(),
      };
      const appendedMessages = fit.appendedMessages ?? [];
      let low = 0;
      let high = boundaries.length - 1;
      let firstFit = -1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = boundaries[mid]!;
        const candidateBound = await this.providerInputUpperBound(
          this.effectiveSystemPrompt,
          [
            plannedSummary,
            ...convertTeamMessagesToLlm(messages.slice(candidate)),
            ...appendedMessages,
          ],
          this.agent.state.tools ?? [],
        );
        if (candidateBound <= fit.maxInputTokens) {
          firstFit = candidate;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      if (firstFit < 0) return false;
      cut = firstFit;
    } else {
      let acc = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        acc += convertTeamMessageToLlm(messages[i]).reduce((sum, message) => sum + countMessage(message), 0);
        if (acc >= settings.keepRecentTokens) {
          cut = i;
          break;
        }
      }
      while (cut < messages.length && !isAgentPromptBoundary(messages[cut]!)) cut++;
    }
    if (cut <= 0 || cut >= messages.length) return false;

    const older = messages.slice(0, cut);
    const recent = messages.slice(cut);
    const apiKey = this.getKey(this.model.provider);
    if (!apiKey) return false;

    const prevSummaryTokens = this.previousSummary ? countText(this.previousSummary) : 0;
    const summaryBudget = contextWindow - settings.reserveTokens - prevSummaryTokens - 12000;
    let olderTokens = 0;
    for (const m of older) {
      olderTokens += convertTeamMessageToLlm(m).reduce((sum, message) => sum + countMessage(message), 0);
    }
    const primaryInputBudget = Math.max(
      256,
      Math.min(summaryBudget > 0 ? summaryBudget : 256, COMPACTION_SUMMARY_INPUT_CTX, Math.floor(contextWindow * 0.4)),
    );
    const olderLlm = convertTeamMessagesToLlm(older);
    const primaryInput = selectCompactionSummaryInput(olderLlm, primaryInputBudget);
    if (olderTokens > primaryInput.ctx || primaryInput.omitted > 0) {
      console.warn(
        `[agent-session] bounded compaction input (session ${this.sessionId}): older ~${olderTokens} ctx; ` +
          `summarizing most-recent ${primaryInput.messages.length}/${older.length} msgs (~${primaryInput.ctx} ctx; older head archived)`,
      );
    }

    const compactionId = "cmp_" + crypto.randomUUID();
    const compactionStartedAt = Date.now();
    this.compactionInFlight = true;
    this.emitAgent({ t: "compaction_start", id: compactionId, summarizedCount: older.length });
    logAudit("compaction_start", {
      level: "info",
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: {
        compactionId,
        phase: compactionPhase,
        summarizedCount: older.length,
        summaryInputCount: primaryInput.messages.length,
        summaryInputCtx: primaryInput.ctx,
        ctxBefore: contextTokens,
        ctxWindow: contextWindow,
        maxWaitMs: COMPACTION_SUMMARY_TIMEOUT_MS + COMPACTION_SUMMARY_RETRY_TIMEOUT_MS,
      },
    });
    let markerEmitted = false;
    let compacted = false;
    let summarySource: "llm" | "local_fallback" = "llm";
    let summaryAttempts = 0;
    let finalInput: SummaryInputSelection = primaryInput;
    try {
      const callSummary = async (input: SummaryInputSelection, timeoutMs: number): Promise<string> => {
        summaryAttempts++;
        finalInput = input;
        const generated = await runBoundedCompactionSummary(timeoutMs, signal, (attemptSignal) => generateSummary(
          input.messages,
          this.model,
          settings.reserveTokens,
          apiKey,
          (this.model as { headers?: Record<string, string> }).headers,
          attemptSignal,
          undefined,
          this.previousSummary,
          "low",
          (model, context, options) => streamSimple(model, context, {
            ...options,
            maxTokens: Math.min(options?.maxTokens ?? COMPACTION_SUMMARY_OUTPUT_CTX, COMPACTION_SUMMARY_OUTPUT_CTX),
            timeoutMs,
            sessionId: this.sessionId,
          }),
        ));
        const clean = generated.trim();
        if (!clean) throw new Error("Compaction summary returned no text");
        return clean;
      };

      let summary: string | null = null;
      let summaryError: unknown;
      try {
        summary = await callSummary(primaryInput, COMPACTION_SUMMARY_TIMEOUT_MS);
      } catch (firstError) {
        if (signal?.aborted || firstError instanceof CompactionSummaryAbortedError) throw firstError;
        summaryError = firstError;
        const kind = classifyError(firstError).errorKind;
        const retryable = !(
          firstError instanceof CompactionSummaryTimeoutError
          || ["cyber_policy", "auth", "quota", "provider_config", "request"].includes(kind)
        );
        if (retryable) {
          const retryBudget = Math.max(256, Math.min(primaryInputBudget, COMPACTION_SUMMARY_RETRY_INPUT_CTX));
          const retryInput = selectCompactionSummaryInput(olderLlm, retryBudget);
          console.warn(
            `[agent-session] compaction summary failed (${kind}); retrying once with ` +
              `${retryInput.messages.length} msgs / ~${retryInput.ctx} ctx`,
          );
          try {
            summary = await callSummary(retryInput, COMPACTION_SUMMARY_RETRY_TIMEOUT_MS);
          } catch (retryError) {
            if (signal?.aborted || retryError instanceof CompactionSummaryAbortedError) throw retryError;
            summaryError = retryError;
          }
        }
      }

      if (!summary) {
        summarySource = "local_fallback";
        summary = buildExtractiveCompactionSummary(olderLlm, this.previousSummary);
        logAudit("compaction_degraded", {
          level: "warn",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            compactionId,
            phase: compactionPhase,
            errorKind: errorKind(summaryError),
            reason: rawErrorText(summaryError),
            attempts: summaryAttempts,
            durationMs: Date.now() - compactionStartedAt,
            summaryInputCount: finalInput.messages.length,
            summaryInputCtx: finalInput.ctx,
          },
        });
      }
      if (signal?.aborted) {
        logAudit("compaction_aborted", {
          level: "info",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { compactionId, phase: compactionPhase, durationMs: Date.now() - compactionStartedAt },
        });
        return false;
      }
      const summaryMsg: Message = {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX} The earlier part of this conversation was compacted to fit the model's context window. Summary of what happened so far:\n\n${summary}`,
        timestamp: Date.now(),
      };
      const nextMessages = [summaryMsg, ...recent];
      if (fit) {
        const prospectiveInput = await this.providerInputUpperBound(
          this.effectiveSystemPrompt,
          [
            ...convertTeamMessagesToLlm(nextMessages),
            ...(fit.appendedMessages ?? []),
          ],
          this.agent.state.tools ?? [],
        );
        if (prospectiveInput > fit.maxInputTokens) {
          logAudit("compaction_failed", {
            level: "warn",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: {
              compactionId,
              phase: compactionPhase,
              prospectiveInput,
              maxInput: fit.maxInputTokens,
              summarizedCount: older.length,
              durationMs: Date.now() - compactionStartedAt,
            },
          });
          return false;
        }
      }
      this.previousSummary = summary;
      const tokensBefore = contextTokens;
      this.agent.state.messages = nextMessages;
      messageDao.replaceAll(this.sessionId, this.agent.state.messages);
      compacted = true;
      markerEmitted = this.archiveCompaction(older, summary, tokensBefore, nextMessages, compactionId);
      this.lastContextTokens = 0;
      this.emitContextUsage();
      console.log(`[agent-session] compacted ${older.length} msgs → summary (session ${this.sessionId})`);
      logAudit("compaction_ok", {
        level: "info",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          compactionId,
          phase: compactionPhase,
          source: summarySource,
          attempts: summaryAttempts,
          durationMs: Date.now() - compactionStartedAt,
          summarizedCount: older.length,
          summaryInputCount: finalInput.messages.length,
          summaryInputCtx: finalInput.ctx,
          ctxBefore: tokensBefore,
          ctxWindow: contextWindow,
        },
      });
    } catch (e) {
      if (signal?.aborted || e instanceof CompactionSummaryAbortedError) {
        logAudit("compaction_aborted", {
          level: "info",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            compactionId,
            phase: compactionPhase,
            attempts: summaryAttempts,
            durationMs: Date.now() - compactionStartedAt,
          },
        });
        return false;
      }
      console.error("[agent-session] compaction failed (continuing without):", e instanceof Error ? e.message : e);
      logAudit("compaction_failed", {
        level: "warn",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          compactionId,
          phase: compactionPhase,
          errorKind: errorKind(e),
          reason: rawErrorText(e),
          source: summarySource,
          attempts: summaryAttempts,
          durationMs: Date.now() - compactionStartedAt,
          summarizedCount: older.length,
          summaryInputCount: finalInput.messages.length,
          summaryInputCtx: finalInput.ctx,
          ctxUsed: contextTokens,
          ctxWindow: contextWindow,
        },
      });
    } finally {
      this.compactionInFlight = false;
      if (!markerEmitted) this.emitAgent({ t: "compaction_end", id: compactionId });
    }
    return compacted;
  }

  private archiveCompaction(
    older: AgentMessage[],
    summary: string,
    tokensBefore: number,
    nextMessages: AgentMessage[],
    id: string,
  ): boolean {
    try {
      const tokensAfter = convertTeamMessagesToLlm(nextMessages).reduce((acc, m) => acc + countMessage(m), 0);
      const seq = this.nextSeq();
      compactionDao.create({
        id,
        session_id: this.sessionId,
        seq,
        summarized_count: older.length,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        summary_text: summary,
        archived_json: JSON.stringify(older),
        created_at: Date.now(),
      });
      const item: TimelineItem = {
        kind: "compaction",
        id,
        seq,
        ts: Date.now(),
        compactionId: id,
        summarizedCount: older.length,
        tokensBefore,
        tokensAfter,
      };
      this.persist(item);
      this.emitAgent({ t: "compaction", id, compactionId: id, summarizedCount: older.length, tokensBefore, tokensAfter });
      return true;
    } catch (e) {
      console.error("[agent-session] compaction archive failed (continuing without marker):", e instanceof Error ? e.message : e);
      logAudit("compaction_failed", {
        level: "warn",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          compactionId: id,
          phase: "archive",
          errorKind: errorKind(e),
          reason: rawErrorText(e),
          summarizedCount: older.length,
          ctxBefore: tokensBefore,
        },
      });
      return false;
    }
  }

  interrupt(
    preserveRecapJob = false,
    preserveQueuedFollowUps = false,
    authEpochOrTeamInterruption?: number | { origin: "user" | "system"; reason: string },
  ): void {
    const teamInterruption = typeof authEpochOrTeamInterruption === "object"
      ? authEpochOrTeamInterruption
      : {
          origin: "user" as const,
          reason: "Team Turn cancelled by the user.",
        };
    if (typeof authEpochOrTeamInterruption === "number") {
      runInImmediateTransaction(() => {
        assertAuthEpochInWriterTransaction(this.userId, authEpochOrTeamInterruption);
        this.interrupt(preserveRecapJob, preserveQueuedFollowUps, teamInterruption);
      });
      return;
    }
    this.clearPendingRecap(preserveRecapJob);
    if (this.currentTeamTurnTaskId) this.currentTeamInterruption = teamInterruption;
    this.turnAbort?.abort();
    this.agent.abort();
    if (!this.closed && this.proposedToolCalls.size > 0) {
      this.terminalizeUndispatchedTools("cancelled", "Interrupted before this tool could run.");
    }
    this.agent.clearAllQueues();
    if (pendingMessageDao.listPending(this.sessionId).length > 0) {
      let changed = 0;
      if (preserveQueuedFollowUps) {
        changed = pendingMessageDao.reclassifyPendingKind(this.sessionId, "steer", "queue");
      } else {
        if (
          this.currentQueuedPendingId &&
          pendingMessageDao.markConsumed(this.sessionId, this.currentQueuedPendingId)
        ) {
          this.currentQueuedPendingClaimed = true;
          changed++;
        }
        changed += pendingMessageDao.deleteAll(this.sessionId);
      }
      if (changed > 0) {
        this.pendingQueueChanged();
        if (!this.closed) this.emitPendingQueue();
      }
    }
    for (const [requestId, p] of this.pendingPermissions) {
      p.resolve("turn_aborted");
      this.pendingPermissions.delete(requestId);
    }
  }

  private requeueUndeliveredSteers(reason: "turn_failure"): number {
    this.agent.clearSteeringQueue();
    const changed = pendingMessageDao.reclassifyPendingKind(this.sessionId, "steer", "queue");
    if (changed <= 0) return 0;
    this.pendingQueueChanged();
    if (!this.closed) this.emitPendingQueue();
    logAudit("pending_steer_requeued", {
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { turnId: this.currentTurnId, reason, count: changed },
    });
    return changed;
  }

  resolvePermission(requestId: string, decision: PermissionDecision, authEpoch?: number): void {
    if (authEpoch !== undefined) {
      runInImmediateTransaction(() => {
        assertAuthEpochInWriterTransaction(this.userId, authEpoch);
        this.resolvePermission(requestId, decision);
      });
      return;
    }
    const p = this.pendingPermissions.get(requestId);
    if (!p) return;
    this.pendingPermissions.delete(requestId);
    p.resolve(decision);
  }

  retireInternalTeamTurn(
    taskId: string,
    turnId: string,
    retirement: string | Omit<TeamTurnRetirement, "taskId" | "turnId">,
  ): boolean {
    if (!this.ownsInternalTeamTurn(taskId, turnId)) return false;
    this.closeRuntime({
      taskId,
      turnId,
      ...(typeof retirement === "string" ? { reason: retirement } : retirement),
    });
    return true;
  }

  close(publishRecoveredStatus = false): void {
    this.closeRuntime(undefined, publishRecoveredStatus);
  }

  private closeRuntime(
    retirement?: TeamTurnRetirement,
    publishRecoveredStatus = false,
  ): void {
    if (this.closed) return;
    if (this.currentTeamTurnTaskId && this.currentTeamAttempt) {
      for (const reservation of this.currentTeamTokenReservations) {
        try {
          teamTaskDao.cancelProviderReservation({
            userId: this.userId,
            taskId: this.currentTeamTurnTaskId,
            expectedTaskLeaseGeneration: this.currentTeamAttempt.taskGeneration,
            mailId: this.currentTeamAttempt.mailId,
            claimToken: this.currentTeamAttempt.claimToken,
            claimGeneration: this.currentTeamAttempt.claimGeneration,
            reservedTokens: reservation.reservedTokens,
            at: Date.now(),
          });
        } catch (error) {
          logAudit("team_provider_reservation_retire_failed", {
            level: "warn",
            userId: this.userId,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: { taskId: this.currentTeamTurnTaskId, errorKind: errorKind(error) },
          });
        }
      }
      this.currentTeamTokenReservations = [];
    }
    this.closed = true;
    this.turnAcceptingSteer = false;
    this.interrupt(
      true,
      true,
      retirement
        ? { origin: "system", reason: retirement.reason }
        : { origin: "system", reason: "Team Turn interrupted by runtime replacement." },
    );
    recoverInterruptedSession(this.sessionId, retirement);
    if (publishRecoveredStatus) {
      const recoveredStatus = sessionDao.byId(this.sessionId)?.status ?? "idle";
      this.status = recoveredStatus;
      const event: ServerEvent = { type: "session_status", sessionId: this.sessionId, status: recoveredStatus };
      try { this.emit(event); } catch {  }
      try { this.onWake?.(event); } catch {  }
    }
    this.killPty();
    this.stopLoadSampler();
    this.clearRecapTimer();
    if (this.updateTimer != null) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.resultAckDrainTimer !== null) {
      clearTimeout(this.resultAckDrainTimer);
      this.resultAckDrainTimer = null;
    }
    this.pendingUpdate = null;
    this.listeners.clear();
    this.onWake = null;
    this.onBackgroundIdle = null;
    this.onBackgroundAttemptEnd = null;
    this.contextDigestRenderer.clear();
    void this.agentSupervisor?.close();
    this.sandbox.close?.();
    for (const s of this.toolSources) void s.close?.();
  }

  private refreshRecoveredJoinedProjection(taskId: string): void {
    if (this.closed) return;
    const projection = joinedTaskProgressDao.projectionByTask(this.userId, taskId);
    if (!projection || projection.progress.source !== "recovery") return;
    const { parent, progress } = projection;
    const current = this.toolItems.get(parent.id);
    const currentProgress = current?.childProgress;
    const alreadyHydrated = (
      currentProgress?.taskId === progress.taskId
      && currentProgress.leaseGeneration === progress.leaseGeneration
      && currentProgress.lastSeq >= progress.lastSeq
    );
    if (!alreadyHydrated) {
      this.toolItems.set(parent.id, parent);
      this.notePersisted(parent);
    }
    if (!parent.childProgress) throw new Error("Recovered Child projection is missing its cursor");
    this.emitAgent({
      t: "subagent_snapshot",
      parentId: parent.id,
      children: parent.children ?? [],
      progress: parent.childProgress,
    });
    for (const event of this.legacyRecoveredChildEvents(
      current?.children ?? [],
      parent.children ?? [],
      progress.status,
      progress.turnId,
      progress.completedAt ?? progress.updatedAt,
      progress.durationMs ?? Math.max(0, (progress.completedAt ?? progress.updatedAt) - progress.startedAt),
    )) {
      this.emitAgent({ t: "subagent_event", parentId: parent.id, event });
    }
  }

  private legacyRecoveredChildEvents(
    before: TimelineItem[],
    after: TimelineItem[],
    status: AgentTurnStatus,
    turnId: string,
    completedAt: number,
    durationMs: number,
  ): WireAgentEvent[] {
    const terminalTool = status === "failed" ? "error" as const : "denied" as const;
    const beforeById = new Map(before.map((item) => [item.id, item]));
    const afterById = new Map(after.map((item) => [item.id, item]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const events: WireAgentEvent[] = [];
    for (const id of ids) {
      const prior = beforeById.get(id);
      const next = afterById.get(id);
      const priorAssistant = prior?.kind === "assistant" ? prior : undefined;
      const nextAssistant = next?.kind === "assistant" ? next : undefined;
      if ((priorAssistant?.streaming || nextAssistant?.streaming === false) && (nextAssistant ?? priorAssistant)) {
        const resolved = nextAssistant ?? priorAssistant!;
        events.push({
          t: "assistant_end",
          id,
          blocks: resolved.blocks,
          usage: resolved.usage,
          turnId,
        });
        continue;
      }
      const priorTool = prior?.kind === "tool" ? prior : undefined;
      const nextTool = next?.kind === "tool" ? next : undefined;
      if (!priorTool && !nextTool) continue;
      if (priorTool && TERMINAL_TOOL_STATUSES.has(priorTool.status) && !nextTool) continue;
      const resolved = nextTool ?? priorTool!;
      const resolvedTerminal = TERMINAL_TOOL_STATUSES.has(resolved.status);
      const resolvedStatus = resolvedTerminal ? resolved.status : terminalTool;
      const termination = resolved.termination
        ?? (status === "interrupted" && !resolvedTerminal ? "cancelled" as const : undefined);
      events.push({
        t: "tool_end",
        id,
        status: resolvedStatus,
        ...(termination ? { termination } : {}),
        resultText: resolved.resultText
          ? resolved.resultText
          : resolvedStatus === "error"
            ? "The Child Agent stopped before this tool settled."
            : resolvedStatus === "denied"
              ? "Interrupted before this tool settled."
              : "(no output)",
        isError: resolved.isError ?? (resolvedStatus === "error"),
        durationMs: resolved.durationMs,
        shell: resolved.shell,
        edit: resolved.edit,
        name: resolved.name,
        toolKind: resolved.toolKind,
        path: resolved.path,
        arguments: resolved.arguments,
        turnId,
      });
    }
    events.push({
      t: "turn_end",
      turnId,
      status,
      completedAt,
      durationMs,
    });
    return events;
  }

  private async runSubagent(parentToolCallId: string, task: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason ?? new Error("SubAgent delegation was aborted");
    const supervisor = this.requireAgentSupervisor();
    const configured = sessionDao.byId(this.sessionId) ?? this.row;
    const turnSnapshot = this.currentTurnExecution;
    const provider = turnSnapshot?.provider ?? configured.provider;
    const model = turnSnapshot?.model ?? configured.model;
    const modelInfo = resolveModel(provider, model);
    const thinkingLevel = turnSnapshot?.thinkingLevel
      ?? effectiveThinkingLevel(modelInfo, configured.thinking_level);
    const poolSize = Math.min(4, supervisor.limits.maxActivePerParent);
    const slots = Array.from({ length: poolSize }, (_, index) => `/root/joined_slot_${index + 1}`);
    const existing = slots.flatMap((path) => {
      const agent = agentNodeDao.directTargets(this.userId, this.rootAgentId, path)
        .find((node) => node.purpose === "joined_slot" && node.status !== "closed");
      return agent ? [{ path, open: runtimeTaskDao.countOpenByAgent(this.userId, agent.id) }] : [];
    });
    const idle = existing.find((slot) => slot.open === 0);
    const missing = slots.find((path) =>
      agentNodeDao.directTargets(this.userId, this.rootAgentId, path).length === 0);
    let handle: AgentTaskHandle;
    if (idle || !missing) {
      const slot = idle ?? [...existing].sort((left, right) => left.open - right.open || left.path.localeCompare(right.path))[0];
      if (!slot) throw new Error("No joined SubAgent slot is available");
      handle = supervisor.followUp({
        target: slot.path,
        message: task,
        ownerTurnId: this.currentTurnId ?? undefined,
        ownerStepId: parentToolCallId,
        awaitPolicy: "join",
        cancelPolicy: "linked",
        resetContext: true,
        internalAgentConfig: { provider, model, thinkingLevel },
      });
    } else {
      handle = supervisor.spawn({
        taskName: missing.slice("/root/".length),
        message: task,
        context: "none",
        provider,
        model,
        thinkingLevel,
        initialMessages: [],
        ownerTurnId: this.currentTurnId ?? undefined,
        ownerStepId: parentToolCallId,
        awaitPolicy: "join",
        cancelPolicy: "linked",
        internalPurpose: "joined-slot",
      });
    }
    const interrupt = () => {
      try { supervisor.interruptTask(handle.taskId); } catch {  }
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      let revision = handle.revision;
      while (true) {
        const current = runtimeTaskDao.byId(this.userId, handle.taskId);
        if (!current) throw new Error("Durable SubAgent Task disappeared");
        if (["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)) break;
        const changed = await supervisor.waitForChange({
          afterRevision: revision,
          targets: [handle.path],
          timeoutMs: 30_000,
          ...(signal ? { signal } : {}),
        });
        revision = changed.revision;
      }
    } catch (error) {
      interrupt();
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        const current = runtimeTaskDao.byId(this.userId, handle.taskId);
        if (!current || ["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }

    const final = runtimeTaskDao.byId(this.userId, handle.taskId);
    const result = taskResultDao.byTask(this.userId, handle.taskId);
    if (result && result.acknowledgedAt === undefined) {
      taskResultDeliveryDao.stage({
        userId: this.userId,
        sessionId: this.sessionId,
        deliveryAgentId: this.rootAgentId,
        deliveryStepId: parentToolCallId,
        results: [{ taskId: handle.taskId, expectedVersion: result.version }],
        acknowledgeOnError: true,
        at: Date.now(),
      });
    }
    if (final?.status !== "succeeded") {
      throw new Error(result?.summary || `SubAgent ${final?.status ?? "disappeared"}`);
    }
    const report = result?.body && !Array.isArray(result.body) && typeof result.body === "object"
      && typeof result.body.report === "string"
      ? result.body.report
      : undefined;
    return report || result?.summary || "SubAgent finished without a text report.";
  }

  private activeTeamToolParent(): TeamToolParent | undefined {
    if (!this.currentTeamTurnTaskId || !this.currentTeamAttempt) return undefined;
    return {
      mailId: this.currentTeamAttempt.mailId,
      taskId: this.currentTeamTurnTaskId,
      expectedTaskLeaseGeneration: this.currentTeamAttempt.taskGeneration,
      claimToken: this.currentTeamAttempt.claimToken,
      claimGeneration: this.currentTeamAttempt.claimGeneration,
    };
  }

  private needsApproval(toolName: string): boolean {
    if (this.row.sandbox_mode === "danger-full-access") return false;
    const policy = this.row.approval_policy;
    if (policy === "never") return false;
    if (this.sessionApproved.has(toolName)) return false;
    if (policy === "untrusted") return true;
    return APPROVAL_GATED_TOOLS.has(toolName)
      || DELEGATION_TOOLS.has(toolName)
      || TEAM_TOOL_NAMES.has(toolName)
      || toolName.startsWith("mcp__");
  }

  private cancelToolBeforeRun(callId: string, resultText = "Interrupted before this tool could run."): void {
    this.deniedCalls.add(callId);
    const item = this.toolItems.get(callId);
    if (item) {
      item.status = "denied";
      item.termination = "cancelled";
      item.resultText = resultText;
      item.isError = false;
      this.persist(item);
    }
    this.emitAgent({
      t: "tool_end",
      id: callId,
      status: "denied",
      termination: "cancelled",
      resultText,
      isError: false,
      turnId: this.currentTurnId ?? undefined,
    });
  }

  private async handleBeforeToolCall(
    ctx: { toolCall: ToolCall; args: unknown },
    signal?: AbortSignal,
  ): Promise<{ block: boolean; reason?: string } | undefined> {
    const call = ctx.toolCall;
    const args = (ctx.args ?? call.arguments ?? {}) as Record<string, unknown>;

    const path = typeof args.path === "string" ? args.path : undefined;
    if (!this.toolItems.has(call.id)) {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        kind: "tool",
        id: call.id,
        seq: this.nextSeq(),
        name: call.name,
        toolKind: toolKind(call.name),
        path,
        arguments: args,
        status: "pending",
        ts: Date.now(),
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      };
      this.toolItems.set(call.id, item);
      this.persist(item);
      this.emitAgent({ t: "tool_start", id: call.id, name: call.name, toolKind: item.toolKind, path, arguments: args, turnId: this.currentTurnId ?? undefined });
    } else {
      const item = this.toolItems.get(call.id)!;
      item.arguments = args;
      if (path !== undefined) item.path = path;
      this.persist(item);
      this.emitAgent({ t: "tool_start", id: call.id, name: item.name, toolKind: item.toolKind, path: item.path, arguments: args, turnId: this.currentTurnId ?? undefined });
      this.updateToolStatus(call.id, "pending");
    }

    if (this.currentTeamTurnTaskId && call.name === "team_create") {
      this.cancelToolBeforeRun(call.id);
      return { block: true, reason: "A Team work Turn cannot create another Team." };
    }
    if (this.currentTeamTurnTaskId && DELEGATION_TOOLS.has(call.name)) {
      this.cancelToolBeforeRun(call.id);
      return { block: true, reason: "Team Turns cannot start nested Agents without a delegated Team budget." };
    }

    if (signal?.aborted) {
      this.cancelToolBeforeRun(call.id);
      return { block: true, reason: "The turn was interrupted before this tool could run." };
    }

    if (!this.needsApproval(call.name)) {
      this.toolStartedAt.set(call.id, Date.now());
      this.updateToolStatus(call.id, "running");
      return undefined;
    }

    const requestId = "perm_" + crypto.randomUUID();
    const request: PermissionRequestPayload = {
      requestId,
      toolName: call.name,
      toolCallId: call.id,
      summary: describeToolCall(call.name, args),
      command: call.name === "bash" ? String(args.command ?? "") : undefined,
      path: typeof args.path === "string" ? args.path : undefined,
    };
    const decision = await new Promise<PendingPermissionDecision>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, request });
      this.emit({ type: "permission_request", sessionId: this.sessionId, request });
      this.wake("approval");
      if (signal) {
        const onAbort = () => {
          if (this.pendingPermissions.delete(requestId)) resolve("turn_aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const turnAborted = decision === "turn_aborted" || Boolean(signal?.aborted);
    this.emit({
      type: "permission_resolved",
      sessionId: this.sessionId,
      requestId,
      decision: turnAborted ? "deny" : decision,
    });
    logAudit("tool_permission", {
      level: decision === "deny" ? "warn" : "info",
      userId: this.row.user_id,
      sessionId: this.sessionId,
      targetId: this.auditTargetId(),
      data: { requestId, toolCallId: call.id, toolName: call.name, decision },
    });

    if (turnAborted) {
      this.cancelToolBeforeRun(call.id);
      return { block: true, reason: "The turn was interrupted before this tool could run." };
    }

    if (decision === "deny") {
      this.deniedCalls.add(call.id);
      this.updateToolStatus(call.id, "denied");
      const item = this.toolItems.get(call.id);
      if (item) {
        item.status = "denied";
        item.resultText = "Denied by user.";
        item.isError = true;
        this.persist(item);
      }
      this.emitAgent({ t: "tool_end", id: call.id, status: "denied", resultText: "Denied by user.", isError: true, turnId: this.currentTurnId ?? undefined });
      return { block: true, reason: "The user denied permission to run this tool." };
    }

    if (decision === "approve_session") {
      this.sessionApproved.add(call.name);
      sessionDao.setApprovedTools(this.sessionId, [...this.sessionApproved]);
    }
    this.toolStartedAt.set(call.id, Date.now());
    this.updateToolStatus(call.id, "running");
    return undefined;
  }

  private static rank(s: ToolCallStatus): number {
    return { streaming_args: 0, ready: 1, pending: 2, approved: 3, running: 4, success: 5, error: 5, denied: 5 }[s] ?? 0;
  }

  private terminalizeUndispatchedTools(
    status: "error" | "cancelled",
    resultText: string,
  ): void {
    const now = Date.now();
    const persistedStatus: ToolCallStatus = status === "cancelled" ? "denied" : "error";
    for (const [id, proposed] of this.proposedToolCalls) {
      const existing = this.toolItems.get(id);
      if (existing && AgentSessionRuntime.rank(existing.status) >= AgentSessionRuntime.rank("pending")) {
        this.proposedToolCalls.delete(id);
        continue;
      }
      const item: Extract<TimelineItem, { kind: "tool" }> = existing ?? {
        kind: "tool",
        id,
        seq: this.nextSeq(),
        name: proposed.name,
        toolKind: proposed.toolKind,
        path: proposed.path,
        arguments: proposed.arguments,
        status: persistedStatus,
        ts: proposed.ts,
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      };
      item.status = persistedStatus;
      item.termination = status === "cancelled" ? "cancelled" : undefined;
      item.resultText = resultText;
      item.isError = status === "error";
      this.toolItems.set(id, item);
      this.persist(item);
      this.emitAgent({
        t: "tool_end",
        id,
        status: persistedStatus,
        termination: status === "cancelled" ? "cancelled" : undefined,
        resultText,
        isError: status === "error",
        name: proposed.name,
        toolKind: proposed.toolKind,
        path: proposed.path,
        arguments: proposed.arguments,
        turnId: this.currentTurnId ?? undefined,
      });
      logAudit("tool_not_dispatched", {
        level: status === "error" ? "warn" : "info",
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          turnId: this.currentTurnId,
          modelRound: this.modelRoundOrdinal,
          toolCallId: id,
          toolName: proposed.name,
          status,
          phase: this.toolArgumentsReadyAt.has(id) ? "ready" : "streaming_args",
          argumentsReadyWaitMs: this.toolArgumentsReadyAt.has(id)
            ? Math.max(0, now - this.toolArgumentsReadyAt.get(id)!)
            : null,
          constructionWaitMs: this.toolArgumentsReadyAt.has(id)
            ? null
            : Math.max(0, now - proposed.ts),
        },
      });
      this.proposedToolCalls.delete(id);
      this.toolArgumentsStartedAt.delete(id);
      this.toolArgumentsReadyAt.delete(id);
      this.toolDispatchedAt.delete(id);
    }
  }

  private updateToolStatus(id: string, status: ToolCallStatus): void {
    const item = this.toolItems.get(id);
    if (item && AgentSessionRuntime.rank(status) < AgentSessionRuntime.rank(item.status)) {
      return;
    }
    if (item) {
      item.status = status;
      this.persist(item);
    }
    const startedAt = status === "running" ? this.toolStartedAt.get(id) : undefined;
    this.emitAgent({
      t: "tool_status",
      id,
      status,
      runningElapsedMs: startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt),
      turnId: this.currentTurnId ?? undefined,
    });
    if (status === "running") {
      const now = Date.now();
      const readyAt = this.toolArgumentsReadyAt.get(id);
      const dispatchedAt = this.toolDispatchedAt.get(id);
      logAudit("tool_running", {
        userId: this.row.user_id,
        sessionId: this.sessionId,
        targetId: this.auditTargetId(),
        data: {
          turnId: this.currentTurnId,
          modelRound: this.modelRoundOrdinal,
          toolCallId: id,
          argumentsReadyToRunningMs: readyAt == null ? null : now - readyAt,
          dispatchToRunningMs: dispatchedAt == null ? null : now - dispatchedAt,
        },
      });
    }
  }

  private currentAssistantId: string | null = null;
  private currentTurnId: string | null = null;
  private currentTeamTurnTaskId: string | null = null;
  private currentTeamAttempt: {
    taskGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    deadlineAt: number;
  } | null = null;
  private currentTeamInterruption: { origin: "user" | "system"; reason: string } | null = null;
  private currentTeamTokenReservations: Array<{
    reservedTokens: number;
    inputUpperBound: number;
  }> = [];
  private currentTurnExecution: Readonly<{
    provider: string;
    model: string;
    thinkingLevel: NonNullable<AgentNode["thinkingLevel"]>;
  }> | null = null;
  private currentQueuedPendingId: string | null = null;
  private currentQueuedPendingClaimed = false;
  private turnFirstTokenAt: number | null = null;
  private pendingCapture: { request: unknown; requestTs: number; responseMeta?: ResponseMeta } | null = null;

  private async onAgentEvent(event: AgentEvent, _signal: AbortSignal): Promise<void> {
    if (this.closed) return;
    switch (event.type) {
      case "turn_start":
        this.modelRoundOrdinal++;
        this.modelRoundStartedAt = Date.now();
        this.providerStreamTiming.beginRound(this.modelRoundStartedAt);
        logAudit("model_round_start", {
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: { turnId: this.currentTurnId, modelRound: this.modelRoundOrdinal },
        });
        break;

      case "message_start": {
        const m = event.message as Message;
        if (m.role === "user") {
          const pending = this.pendingUserItem;
          if (pending && pending.kind === "user") {
            this.pendingUserItem = null;
            this.pendingUserMsgCut = null;
            break;
          }
          const raw = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
          const text = stripTime(raw);
          const promoted = pendingMessageDao.findUnconsumedSteerByText(this.sessionId, text);
          const item: TimelineItem = {
            kind: "user",
            id: "u_" + crypto.randomUUID(),
            seq: this.nextSeq(),
            text,
            ts: Date.now(),
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          };
          const msgCut = this.pendingUserMsgCut ?? undefined;
          let consumedPromoted = false;
          if (promoted) {
            consumedPromoted = runInTransaction(() => {
              if (!pendingMessageDao.markConsumed(this.sessionId, promoted.id)) return false;
              timelineDao.append(this.sessionId, item, msgCut);
              return true;
            });
            if (consumedPromoted) this.notePersisted(item);
            else this.persist(item, msgCut);
          } else {
            this.persist(item, msgCut);
          }
          this.pendingUserMsgCut = null;
          this.emitAgent({ t: "user_message", id: item.id, text, seq: item.seq, turnId: item.turnId });
          if (consumedPromoted) {
            this.pendingQueueChanged();
            this.emitPendingQueue();
          }
        } else if (m.role === "assistant") {
          this.currentAssistantId = "a_" + crypto.randomUUID();
          this.emitAgent({ t: "assistant_start", id: this.currentAssistantId, turnId: this.currentTurnId ?? undefined });
        }
        break;
      }

      case "message_update": {
        const m = event.message as Message;
        if (m.role === "assistant" && this.currentAssistantId) {
          const updateAt = Date.now();
          const streamEvent = event.assistantMessageEvent;
          if (this.turnFirstTokenAt === null && streamEvent.type.endsWith("_delta")) {
            this.turnFirstTokenAt = updateAt;
          }
          this.providerStreamTiming.observeUpdate(streamEvent.type, updateAt);
          const indexedBlock = "contentIndex" in streamEvent ? m.content[streamEvent.contentIndex] : undefined;
          if ((streamEvent.type === "toolcall_start" || streamEvent.type === "toolcall_delta") && indexedBlock?.type === "toolCall") {
            const streamingToolId = indexedBlock.id;
            const startedAt = this.toolArgumentsStartedAt.get(streamingToolId) ?? Date.now();
            this.toolArgumentsStartedAt.set(streamingToolId, startedAt);
            const previous = this.proposedToolCalls.get(streamingToolId);
            const args = (indexedBlock.arguments ?? {}) as Record<string, unknown>;
            this.proposedToolCalls.set(streamingToolId, {
              name: indexedBlock.name,
              toolKind: toolKind(indexedBlock.name),
              path: typeof args.path === "string" ? args.path : previous?.path,
              arguments: args,
              ts: previous?.ts ?? startedAt,
            });
          }
          const blocks = this.blocksFromAssistant(m);
          this.emitAgent({ t: "assistant_update", id: this.currentAssistantId, blocks, turnId: this.currentTurnId ?? undefined });
          if (streamEvent.type === "toolcall_end" && !this.toolArgumentsReadyAt.has(streamEvent.toolCall.id)) {
            const readyAt = Date.now();
            const started = this.toolArgumentsStartedAt.get(streamEvent.toolCall.id) ?? readyAt;
            const args = (streamEvent.toolCall.arguments ?? {}) as Record<string, unknown>;
            const path = typeof args.path === "string" ? args.path : undefined;
            this.toolArgumentsStartedAt.set(streamEvent.toolCall.id, started);
            this.toolArgumentsReadyAt.set(streamEvent.toolCall.id, readyAt);
            const proposed = this.proposedToolCalls.get(streamEvent.toolCall.id);
            this.proposedToolCalls.set(streamEvent.toolCall.id, {
              name: streamEvent.toolCall.name,
              toolKind: toolKind(streamEvent.toolCall.name),
              path,
              arguments: args,
              ts: proposed?.ts ?? started,
            });
            logAudit("tool_arguments_ready", {
              userId: this.row.user_id,
              sessionId: this.sessionId,
              targetId: this.auditTargetId(),
              data: {
                turnId: this.currentTurnId,
                modelRound: this.modelRoundOrdinal,
                toolCallId: streamEvent.toolCall.id,
                toolName: streamEvent.toolCall.name,
                argumentBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
                constructionMs: readyAt - started,
              },
            });
            this.emitAgent({ t: "tool_status", id: streamEvent.toolCall.id, status: "ready", turnId: this.currentTurnId ?? undefined });
          }
        }
        break;
      }

      case "message_end": {
        const m = event.message as Message;
        const messageEndStartedAt = Date.now();
        const logProviderMessageHandled = (): void => {
          if (m.role !== "assistant") return;
          logAudit("provider_message_handled", {
            level: m.stopReason === "error" ? "warn" : "info",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: {
              turnId: this.currentTurnId,
              modelRound: this.modelRoundOrdinal,
              handlerMs: Date.now() - messageEndStartedAt,
              stopReason: m.stopReason,
            },
          });
        };
        if (m.role === "assistant") {
          logAudit("provider_stream_settled", {
            level: m.stopReason === "error" ? "warn" : "info",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: {
              turnId: this.currentTurnId,
              modelRound: this.modelRoundOrdinal,
              stopReason: m.stopReason,
              ...this.providerStreamTiming.settle(messageEndStartedAt),
            },
          });
        }
        if (m.role === "assistant" && this.currentAssistantId) {
          if (this.currentTeamTurnTaskId) {
            const reservation = this.currentTeamTokenReservations.shift();
            if (reservation === undefined) {
              if (!(m.stopReason === "error" && (m.usage?.totalTokens ?? 0) === 0)) {
                throw new Error("Team provider response has no matching budget reservation");
              }
            } else {
              const attempt = this.currentTeamAttempt;
              if (!attempt) throw new Error("Team provider response lost its durable lease context");
              const reported = m.usage?.totalTokens;
              const actualTokens = reported == null || (reported === 0 && m.provider !== MOCK_PROVIDER)
                ? isContextOverflow(m)
                  ? reservation.inputUpperBound
                  : reservation.reservedTokens
                : reported;
              const reconciliation = teamTaskDao.reconcileProviderRequest({
                userId: this.userId,
                taskId: this.currentTeamTurnTaskId,
                expectedTaskLeaseGeneration: attempt.taskGeneration,
                mailId: attempt.mailId,
                claimToken: attempt.claimToken,
                claimGeneration: attempt.claimGeneration,
                reservedTokens: reservation.reservedTokens,
                actualTokens,
                at: Date.now(),
              });
              if (reconciliation.overBudget) {
                throw new Error(
                  `Provider reported ${actualTokens} tokens for a ${reservation.reservedTokens}-token Team request budget`,
                );
              }
            }
          }
          const cw = (this.model as { contextWindow?: number }).contextWindow ?? 0;
          if (
            m.stopReason === "error" &&
            !this.overflowRetryAttempted &&
            m.provider === this.model.provider &&
            m.model === this.model.id &&
            (isContextOverflow(m, cw) || this.promptExceedsWindow())
          ) {
            this.overflowRecoveryPending = true;
            this.terminalizeUndispatchedTools(
              "cancelled",
              "Cancelled before execution while the context was recovered.",
            );
            this.emitAgent({ t: "assistant_end", id: this.currentAssistantId, blocks: [], turnId: this.currentTurnId ?? undefined });
            const msgs = this.agent.state.messages;
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
              this.agent.state.messages = msgs.slice(0, -1);
            }
            this.currentAssistantId = null;
            logProviderMessageHandled();
            break;
          }
          const classified = classifyError(m.errorMessage);
          const retryLimit = modelRetryLimit(classified.errorKind);
          if (
            m.stopReason === "error" &&
            classified.retryable &&
            this.modelRetries < retryLimit &&
            !this.promptExceedsWindow() &&
            !this.turnAbort?.signal.aborted
          ) {
            this.modelRetries++;
            this.retryPending = true;
            this.lastModelRetryKind = classified.errorKind;
            const delayMs = modelRetryBackoffMs(this.modelRetries);
            this.terminalizeUndispatchedTools(
              "cancelled",
              "Cancelled before execution while the model request was retried.",
            );
            this.emitAgent({ t: "assistant_end", id: this.currentAssistantId, blocks: [], turnId: this.currentTurnId ?? undefined });
            const msgs = this.agent.state.messages;
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") this.agent.state.messages = msgs.slice(0, -1);
            this.currentAssistantId = null;
            this.emitAgent({
              t: "model_retry",
              attempt: this.modelRetries,
              limit: retryLimit,
              delayMs,
              errorKind: classified.errorKind,
              turnId: this.currentTurnId ?? undefined,
            });
            logAudit("model_retry", {
              level: "info",
              userId: this.row.user_id,
              sessionId: this.sessionId,
              targetId: this.auditTargetId(),
              data: { turnId: this.currentTurnId, attempt: this.modelRetries, limit: retryLimit, delayMs, errorKind: classified.errorKind },
            });
            logProviderMessageHandled();
            break;
          }
          const blocks = this.blocksFromAssistant(m);
          const hasUsage = Boolean(m.usage && m.usage.totalTokens > 0);
          const usage = hasUsage
            ? {
                input: m.usage!.input,
                output: m.usage!.output,
                total: m.usage!.totalTokens,
                costUsd: m.usage!.cost.total,
                cacheRead: m.usage!.cacheRead,
                cacheWrite: m.usage!.cacheWrite,
              }
            : undefined;
          if (hasUsage) this.lastContextTokens = m.usage!.totalTokens;
          const item: TimelineItem = {
            kind: "assistant",
            id: this.currentAssistantId,
            seq: this.nextSeq(),
            blocks,
            ts: Date.now(),
            usage,
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          };
          this.persist(item);
          this.flushCapture(this.currentAssistantId, m);
          this.emitAgent({ t: "assistant_end", id: this.currentAssistantId, blocks, usage, turnId: this.currentTurnId ?? undefined });
          if (m.stopReason !== "error" && m.stopReason !== "aborted" && this.modelRetries > 0 && !this.modelRetryRecoveryLogged) {
            this.modelRetryRecoveryLogged = true;
            logAudit("model_retry_recovered", {
              userId: this.row.user_id,
              sessionId: this.sessionId,
              targetId: this.auditTargetId(),
              data: { turnId: this.currentTurnId, attempts: this.modelRetries, errorKind: this.lastModelRetryKind },
            });
          }
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            let desc = m.stopReason === "aborted"
              ? { message: "Interrupted.", errorKind: "aborted" as string, retryable: false }
              : this.describeError(m.errorMessage || "the model returned an error");
            this.terminalizeUndispatchedTools(
              m.stopReason === "aborted" ? "cancelled" : "error",
              m.stopReason === "aborted"
                ? "Interrupted before this tool could run."
                : "The model response failed before this tool could run.",
            );
            if (m.stopReason === "error") {
              if (desc.errorKind === "auth" && this.model.provider === ORCAROUTER_PROVIDER) {
                // A relay 401 on a durable key is terminal: there is no refresh grant,
                // so mark exactly this credential generation for reauthentication.
                markOrcaNeedsReauth(this.row.user_id, orcaCredentialGeneration(this.row.user_id));
                desc = {
                  message: "Your OrcaRouter credential was rejected — reconnect OrcaRouter in Settings, or paste a new API key. The stored key is kept until a new one is saved.",
                  errorKind: "auth",
                  retryable: false,
                };
              }
              logAudit("turn_error", {
                level: "error",
                userId: this.row.user_id,
                sessionId: this.sessionId,
                targetId: this.auditTargetId(),
                data: { turnId: this.currentTurnId, errorKind: desc.errorKind, retryAttempts: this.modelRetries, raw: rawErrorText(m.errorMessage) },
              });
              this.emitTurnError(desc);
            }
          }
          this.currentAssistantId = null;
        }
        this.emitContextUsage();
        logProviderMessageHandled();
        break;
      }

      case "tool_execution_start": {
        if (this.deniedCalls.has(event.toolCallId)) break;
        this.proposedToolCalls.delete(event.toolCallId);
        const dispatchedAt = Date.now();
        this.toolDispatchedAt.set(event.toolCallId, dispatchedAt);
        const args = (event.args ?? {}) as Record<string, unknown>;
        const path = typeof args.path === "string" ? args.path : undefined;
        if (!this.toolItems.has(event.toolCallId)) {
          const item: Extract<TimelineItem, { kind: "tool" }> = {
            kind: "tool",
            id: event.toolCallId,
            seq: this.nextSeq(),
            name: event.toolName,
            toolKind: toolKind(event.toolName),
            path,
            arguments: args,
            status: "streaming_args",
            ts: Date.now(),
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          };
          this.toolItems.set(event.toolCallId, item);
          this.persist(item);
          this.emitAgent({ t: "tool_start", id: event.toolCallId, name: event.toolName, toolKind: item.toolKind, path, arguments: args, turnId: this.currentTurnId ?? undefined });
        } else {
          const item = this.toolItems.get(event.toolCallId)!;
          item.arguments = args;
          if (path !== undefined) item.path = path;
          this.persist(item);
          this.emitAgent({ t: "tool_start", id: event.toolCallId, name: item.name, toolKind: item.toolKind, path: item.path, arguments: args, turnId: this.currentTurnId ?? undefined });
        }
        logAudit("tool_start", {
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            turnId: this.currentTurnId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolKind: toolKind(event.toolName),
            argumentBytes: Buffer.byteLength(JSON.stringify(event.args ?? {}), "utf8"),
            modelRound: this.modelRoundOrdinal,
            argumentsReadyWaitMs: this.toolArgumentsReadyAt.has(event.toolCallId)
              ? dispatchedAt - this.toolArgumentsReadyAt.get(event.toolCallId)!
              : null,
          },
        });
        break;
      }

      case "tool_execution_end": {
        if (this.deniedCalls.delete(event.toolCallId)) break;
        const cancelled = Boolean(this.turnAbort?.signal.aborted) && !this.currentTurnFailed;
        const resultText = cancelled ? "Interrupted while this tool was running." : extractToolText(event.result);
        const shell = extractShell(event.result);
        const edit = extractEditResult(event.result);
        const status: ToolCallStatus = cancelled ? "denied" : event.isError ? "error" : "success";
        const isError = cancelled ? false : event.isError;
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
        this.toolStartedAt.delete(event.toolCallId);
        this.toolArgumentsStartedAt.delete(event.toolCallId);
        this.toolArgumentsReadyAt.delete(event.toolCallId);
        this.toolDispatchedAt.delete(event.toolCallId);
        this.proposedToolCalls.delete(event.toolCallId);
        let item = this.toolItems.get(event.toolCallId);
        if (item?.toolKind === "subagent") {
          const durable = timelineDao.atSeq(this.sessionId, item.seq);
          if (durable?.kind === "tool" && durable.id === item.id) {
            item = durable;
            this.toolItems.set(item.id, item);
          }
        }
        if (item) {
          item.status = status;
          item.termination = cancelled ? "cancelled" : undefined;
          item.resultText = resultText;
          item.isError = isError;
          if (durationMs !== undefined) item.durationMs = durationMs;
          if (shell) item.shell = shell;
          if (edit) item.edit = edit;
          this.persist(item);
          if (status !== "success") {
            this.discardResultAckStage(
              this.rootAgentId,
              event.toolCallId,
              status === "error",
            );
          }
        }
        logAudit("tool_end", {
          level: isError ? "warn" : "info",
          userId: this.row.user_id,
          sessionId: this.sessionId,
          targetId: this.auditTargetId(),
          data: {
            turnId: this.currentTurnId,
            modelRound: this.modelRoundOrdinal,
            toolCallId: event.toolCallId,
            toolName: item?.name ?? "unknown",
            status: cancelled ? "cancelled" : status,
            durationMs,
            resultBytes: Buffer.byteLength(resultText, "utf8"),
            exitCode: shell?.exitCode,
            timedOut: shell?.timedOut,
          },
        });
        this.emitAgent({
          t: "tool_end",
          id: event.toolCallId,
          status,
          termination: cancelled ? "cancelled" : undefined,
          resultText,
          isError,
          durationMs,
          shell,
          edit,
          turnId: this.currentTurnId ?? undefined,
        });
        break;
      }

      case "turn_end":
        {
          const endedAt = Date.now();
          const message = event.message as Message;
          logAudit("model_round_end", {
            level: message.role === "assistant" && message.stopReason === "error" ? "warn" : "info",
            userId: this.row.user_id,
            sessionId: this.sessionId,
            targetId: this.auditTargetId(),
            data: {
              turnId: this.currentTurnId,
              modelRound: this.modelRoundOrdinal,
              durationMs: this.modelRoundStartedAt == null ? null : endedAt - this.modelRoundStartedAt,
              stopReason: message.role === "assistant" ? message.stopReason : "non_assistant",
              toolResultCount: event.toolResults.length,
              recoveryPending: this.overflowRecoveryPending || this.retryPending,
            },
          });
          this.modelRoundStartedAt = null;
        }
        break;

      case "agent_end":
        break;
    }
  }
}

function extractShell(result: unknown): ShellResult | undefined {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  if (details && typeof details === "object" && "shell" in details) {
    return (details as { shell?: ShellResult }).shell;
  }
  return undefined;
}

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") return result == null ? "" : String(result).trim();
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === "object" && (c as any).type === "text" ? (c as any).text : ""))
      .join("\n")
      .trim();
    if (text) return text;
    return safeStringify(content);
  }
  return safeStringify(result);
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 2);
    if (!s) return "";
    const MAX = 64 * 1024;
    return s.length > MAX ? s.slice(0, MAX) + "\n…(truncated)" : s;
  } catch {
    return "";
  }
}
