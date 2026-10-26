import type { OrchestrationInvalidation, OrchestrationInvalidationSnapshot } from "./orchestration.ts";

export const PROTOCOL_VERSION = 8;
export const TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION = 8;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxKind = "local" | "e2b" | "ssh" | "connector";

export type ExecutorUnavailableReason = "not_configured" | "capacity_unavailable" | "policy_disabled";
export interface ExecutorStatus {
  available: boolean;
  reason?: ExecutorUnavailableReason;
}

export interface ExecutorAvailability {
  local: ExecutorStatus;
  e2b: ExecutorStatus;
}

export interface ConnectorProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  cpuPct: number;
  memPct: number;
  rssBytes: number;
  elapsed: string;
}

export interface ConnectorTelemetry {
  sampledAt: number;
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  cpuCores: number;
  loadAvg: [number, number, number];
  processCount: number;
  processes: ConnectorProcessInfo[];
  cpuKind: "interval" | "load";
  processSource: "native" | "compat" | "unavailable";
}
export type SessionMode = "coding" | "pentest" | "exploit" | "bold";
export type ApprovalPolicy = "never" | "on-request" | "untrusted";
export type SessionStatus = "initializing" | "idle" | "running" | "error" | "closed";

export type AgentTurnStatus = "in_progress" | "completed" | "interrupted" | "failed";

export interface AgentTurn {
  id: string;
  sessionId: string;
  status: AgentTurnStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  startSeq?: number;
  endSeq?: number;
  provider: string;
  model: string;
  source: "user" | "team";
  teamTaskId?: string;
  teamTaskLeaseGeneration?: number;
  teamMailClaimGeneration?: number;
}

export interface ChildProgress {
  taskId: string;
  leaseGeneration: number;
  turnId: string;
  status: AgentTurnStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  lastSeq: number;
  source?: "worker" | "recovery";
  omittedItems?: number;
  omittedBytes?: number;
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  added: number;
  removed: number;
  patch: string;
  binary?: boolean;
}
export interface WorkspaceDiff {
  isRepo: boolean;
  head?: string;
  branch?: string;
  files: DiffFile[];
  truncated?: boolean;
}

export interface UserInfo {
  id: string;
  email: string;
  createdAt: number;
  isAdmin?: boolean;
  hasPassword?: boolean;
  emailVerificationPending?: boolean;
}

export interface ProviderKeyInfo {
  provider: string;
  hint: string;
  updatedAt: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  mock?: boolean;
  thinkingLevels?: ThinkingLevel[];
  /** Input modalities the provider's catalog explicitly declares; absent means text-only. */
  inputModalities?: Array<"text" | "image" | "audio" | "video">;
}

export const OPERATOR_MODEL_PROVIDER = "0AI-jail" as const;

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type EgressState = "direct" | "proxy" | "proxy_invalid" | "jump_only";
export interface SessionEgress {
  state: EgressState;
  detail: string | null;
}

export interface SessionInfo {
  id: string;
  userId: string;
  title: string;
  provider: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxKind: SandboxKind;
  sandboxTargetId?: string | null;
  targetName?: string | null;
  mode: SessionMode;
  approvalPolicy: ApprovalPolicy;
  status: SessionStatus;
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  egress?: SessionEgress;
  isTeamMemberSession?: boolean;
}

export interface AssistantBlockText {
  type: "text";
  text: string;
}
export interface AssistantBlockThinking {
  type: "thinking";
  thinking: string;
}
export interface AssistantBlockToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  toolKind?: ToolKind;
  path?: string;
}
export type AssistantBlock = AssistantBlockText | AssistantBlockThinking | AssistantBlockToolCall;

export type ToolCallStatus = "streaming_args" | "ready" | "pending" | "approved" | "denied" | "running" | "success" | "error";

export type ToolKind =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "list"
  | "subagent"
  | "external"
  | "canvas"
  | "other";

type TurnItem<T> = T & { turnId?: string };

export type TimelineItem =
  | TurnItem<{ kind: "user"; id: string; seq: number; text: string; ts: number }>
  | {
      kind: "team_assignment";
      id: string;
      seq: number;
      taskId: string;
      title: string;
      ts: number;
      turnId: string;
    }
  | {
      kind: "assistant";
      id: string;
      seq: number;
      blocks: AssistantBlock[];
      ts: number;
      streaming?: boolean;
      usage?: { input: number; output: number; total: number; costUsd: number; cacheRead?: number; cacheWrite?: number };
      turnId?: string;
    }
  | {
      kind: "tool";
      id: string;
      seq: number;
      name: string;
      toolKind: ToolKind;
      path?: string;
      arguments: Record<string, unknown>;
      status: ToolCallStatus;
      termination?: "cancelled";
      resultText?: string;
      isError?: boolean;
      ts: number;
      durationMs?: number;
      runningElapsedMs?: number;
      shell?: ShellResult;
      edit?: EditResult;
      children?: TimelineItem[];
      childProgress?: ChildProgress;
      turnId?: string;
    }
  | TurnItem<{ kind: "error"; id: string; seq: number; message: string; ts: number; errorKind?: string; retryable?: boolean }>
  | {
      kind: "compaction";
      id: string;
      seq: number;
      ts: number;
      compactionId: string;
      summarizedCount: number;
      tokensBefore: number;
      tokensAfter: number;
      turnId?: string;
    }
  | {
      kind: "compaction_pending";
      id: string;
      seq: number;
      ts: number;
      summarizedCount: number;
      turnId?: string;
    }
  | TurnItem<{ kind: "interrupted"; id: string; seq: number; ts: number; resumeText?: string }>
  | {
      kind: "recap";
      id: string;
      seq: number;
      text: string;
      ts: number;
      anchorSeq: number;
      contractVersion: number;
      source: "llm" | "fallback";
      generatorProvider: string;
      generatorModel: string;
      turnProvider: string;
      turnModel: string;
      sourceTurnId?: string;
      turnId?: undefined;
    };

export interface PendingMessage {
  id: string;
  kind: "steer" | "queue";
  text: string;
  ts: number;
  ord: number;
}

export function isPendingMessageKind(value: unknown): value is PendingMessage["kind"] {
  return value === "steer" || value === "queue";
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface EditResult {
  patch: string;
  firstChangedLine?: number;
  replacements: number;
  truncated: boolean;
}

export interface SearchMatch {
  sessionId: string;
  sessionTitle: string;
  seq: number;
  kind: string;
  label: string;
  snippet: string;
  ts: number;
}

export interface SearchResponse {
  query: string;
  total: number;
  matches: SearchMatch[];
}

export type WireAgentEvent =
  | { t: "turn_start"; turnId: string; startedAt: number }
  | { t: "turn_end"; turnId: string; status: AgentTurnStatus; completedAt: number; durationMs: number }
  | { t: "user_message"; id: string; text: string; seq: number; turnId?: string }
  | { t: "team_assignment"; id: string; seq: number; taskId: string; title: string; ts: number; turnId: string }
  | { t: "assistant_start"; id: string; turnId?: string }
  | { t: "assistant_update"; id: string; blocks: AssistantBlock[]; turnId?: string }
  | {
      t: "assistant_end";
      id: string;
      blocks: AssistantBlock[];
      usage?: { input: number; output: number; total: number; costUsd: number; cacheRead?: number; cacheWrite?: number };
      turnId?: string;
    }
  | { t: "tool_start"; id: string; name: string; toolKind: ToolKind; path?: string; arguments: Record<string, unknown>; turnId?: string }
  | {
      t: "tool_status";
      id: string;
      status: ToolCallStatus;
      runningElapsedMs?: number;
      turnId?: string;
    }
  | {
      t: "tool_end";
      id: string;
      status: ToolCallStatus;
      resultText: string;
      isError: boolean;
      durationMs?: number;
      shell?: ShellResult;
      edit?: EditResult;
      turnId?: string;
      name?: string;
      toolKind?: ToolKind;
      path?: string;
      arguments?: Record<string, unknown>;
      termination?: "cancelled";
    }
  | {
      t: "subagent_event";
      parentId: string;
      taskId?: string;
      leaseGeneration?: number;
      progressSeq?: number;
      progressAt?: number;
      source?: "worker" | "recovery";
      event: WireAgentEvent;
    }
  | { t: "subagent_snapshot"; parentId: string; children: TimelineItem[]; progress: ChildProgress }
  | { t: "agent_end" }
  | { t: "compaction_start"; id: string; summarizedCount: number; turnId?: string }
  | { t: "compaction_end"; id: string; turnId?: string }
  | { t: "compaction"; id: string; compactionId: string; summarizedCount: number; tokensBefore: number; tokensAfter: number; turnId?: string }
  | {
      t: "recap";
      id: string;
      seq: number;
      text: string;
      ts: number;
      anchorSeq: number;
      contractVersion: number;
      source: "llm" | "fallback";
      generatorProvider: string;
      generatorModel: string;
      turnProvider: string;
      turnModel: string;
      sourceTurnId?: string;
    }
  | { t: "model_retry"; attempt: number; limit: number; delayMs: number; errorKind: string; turnId?: string }
  | { t: "error"; message: string; errorKind?: string; retryable?: boolean; turnId?: string };

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: number;
  version?: string;
}

export function fallbackFileEntryVersion(entry: Pick<FileEntry, "size" | "modifiedAt">): string {
  return `${entry.size.toString(36)}-${Math.max(0, Math.floor(entry.modifiedAt)).toString(36)}`;
}

export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  toolCallId: string;
  summary: string;
  command?: string;
  path?: string;
}

export type PermissionDecision = "approve" | "approve_session" | "deny";

export type ExecutionDenialCode = "suspended" | "email_verification_required" | "draining";
export const PENDING_MUTATION_TYPED_PROTOCOL_VERSION = 6;

export type PendingMutationFailureCode =
  | ExecutionDenialCode
  | "auth_revoked"
  | "pending_mutation_failed";

export type PendingMutationResult =
  | { ok: true }
  | { ok: false; code: PendingMutationFailureCode; message: string };

export interface TimelineReplayCursor {
  epoch: string;
  version: number;
}

export type ClientOp =
  | { type: "ping"; reqId?: string }
  | { type: "subscribe"; reqId?: string; sessionId: string; resume?: TimelineReplayCursor }
  | { type: "send_message"; reqId?: string; sessionId: string; text: string; mode?: "steer" | "queue" | "retry"; canvasState?: string }
  | { type: "interrupt"; reqId?: string; sessionId: string }
  | { type: "clear_pending"; reqId?: string; sessionId: string; pendingId: string }
  | { type: "set_pending_kind"; reqId?: string; sessionId: string; pendingId: string; kind: "steer" | "queue" }
  | { type: "set_pending_text"; reqId?: string; sessionId: string; pendingId: string; text: string }
  | { type: "reorder_pending"; reqId?: string; sessionId: string; order: string[] }
  | { type: "rewind"; reqId?: string; sessionId: string; toSeq: number; newText?: string }
  | { type: "set_sandbox"; reqId?: string; sessionId: string; kind: SandboxKind; targetId?: string | null }
  | {
      type: "permission_response";
      reqId?: string;
      sessionId: string;
      requestId: string;
      decision: PermissionDecision;
    }
  | { type: "subscribe_status"; reqId?: string };

export interface ContextParts {
  system: number;
  tools: number;
  user: number;
  assistant: number;
  toolResults: number;
}

export type ServerEvent =
  | { type: "hello"; userId: string; protocolVersion: number; appVersion: string }
  | { type: "pong"; reqId?: string }
  | { type: "ack"; reqId?: string }
  | { type: "error"; reqId?: string; sessionId?: string; code?: PendingMutationFailureCode; message: string }
  | { type: "session_status"; sessionId: string; status: SessionStatus }
  | { type: "session_activity"; sessionId: string; activity: SessionStatus }
  | {
      type: "session_activity_snapshot";
      activities: Array<{ sessionId: string; activity: SessionStatus }>;
    }
  | ({ type: "orchestration_invalidated" } & OrchestrationInvalidation)
  | { type: "orchestration_invalidation_snapshot"; snapshot: OrchestrationInvalidationSnapshot }
  | { type: "session_wake"; sessionId: string; title: string; kind: "running" | "done" | "error" | "approval" }
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_renamed"; sessionId: string; title: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_rewound"; sessionId: string }
  | { type: "sandbox_changed"; sessionId: string; kind: SandboxKind; targetId?: string | null }
  | {
      type: "sandbox_load";
      sessionId: string;
      kind: SandboxKind;
      cpuPct: number;
      memUsed: number;
      memTotal: number;
    }
  | {
      type: "context_usage";
      sessionId: string;
      used: number;
      measured: number;
      pending: number;
      total: number;
      compactAt: number;
      parts?: ContextParts;
    }
  | {
      type: "timeline_replay";
      sessionId: string;
      epoch: string;
      version: number;
      items: TimelineItem[];
      pending: PendingMessage[];
    }
  | {
      type: "agent_event";
      sessionId: string;
      epoch: string;
      version: number;
      seq: number;
      ts: number;
      event: WireAgentEvent;
    }
  | { type: "recap"; sessionId: string; text: string; ts: number }
  | { type: "sandbox_connecting"; sessionId: string; connecting: boolean }
  | { type: "permission_request"; sessionId: string; request: PermissionRequestPayload }
  | { type: "permission_resolved"; sessionId: string; requestId: string; decision: PermissionDecision }
  | { type: "pending_queue"; sessionId: string; epoch: string; version: number; pending: PendingMessage[] };
