import type {
  UserInfo,
  ModelInfo,
  ProviderKeyInfo,
  SessionInfo,
  TimelineItem,
  FileEntry,
  WorkspaceDiff,
  SandboxMode,
  SandboxKind,
  SessionMode,
  ApprovalPolicy,
  ThinkingLevel,
  SearchResponse,
  ExecutorAvailability,
  ConnectorTelemetry,
} from "@shared/protocol";
import type {
  AgentReadDetail,
  OrchestrationActivityPage,
  OrchestrationPage,
  RuntimeTaskReadDetail,
  SessionRunSnapshot,
  TaskResultReadDetail,
  TeamListPage,
  TeamMailListItem,
  TeamMailReadDetail,
  TeamReadDetail,
  WorkflowListPage,
  WorkflowReadDetail,
} from "@shared/orchestration";

import { getToken, setToken } from "./token.ts";
import { logClient } from "./client-log.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly banned: boolean = false,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends ApiError {
  constructor(readonly cause: unknown) {
    super("Couldn't reach the server. Check your connection and try again.", 0);
    this.name = "NetworkError";
  }
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

export function isGatewayError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 502 || err.status === 503 || err.status === 504);
}

function transportDetail(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export type ArchivedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id?: string; name: string; arguments?: Record<string, unknown> }
  | { type: "image"; mimeType?: string }
  | { type: string; [k: string]: unknown };

export interface ArchivedMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | ArchivedContentBlock[];
  toolName?: string;
  isError?: boolean;
}

export interface CompactionDetailResponse {
  summary: string;
  messages: ArchivedMessage[];
  truncated: boolean;
  summarizedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: number;
}

export interface ModelsResponse {
  models: ModelInfo[];
  e2b?: boolean;
  executors?: ExecutorAvailability;
}

export interface OrcaCredentialState {
  configured: boolean;
  hint: string | null;
  source: "api_key" | "oauth_pkce" | null;
  needsReauth: boolean;
  generation: number;
}

export interface OrcaProviderInfo {
  provider: string;
  label: string;
  keyPrefix: string;
  apiBase: string;
  authBase: string;
  defaults: { apiBase: string; authBase: string };
  dashboardUrl: string;
  providerUrl: string;
  cyberCatalogUrl: string;
  authMethods: Array<"api_key" | "oauth_pkce">;
  credential: OrcaCredentialState;
}

export interface OrcaModelCatalog {
  provider: string;
  modality: "text" | "image";
  source: "live" | "verified_seed";
  degraded: boolean;
  catalogUrl: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    inputModalities: Array<"text" | "image" | "audio" | "video">;
    reasoning: boolean;
  }>;
}

export interface SshTargetInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  verified: boolean;
  protected: boolean;
  unlocked: boolean;
  unconfined: boolean;
  createdAt: number;
}

export interface WrappedKey {
  v: 1;
  credentialId: string;
  salt: string;
  iv: string;
  ct: string;
}

export interface WebauthnCredentialInfo {
  id: string;
  credentialId: string;
  label: string;
  transports: string[];
  createdAt: number;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  workspaceRoot: string;
  capabilities: string[];
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  unconfined: boolean;
  daemonUnconfined?: boolean | null;
}

export interface ConnectorPairingInfo {
  id: string;
  name: string;
  workspaceRoot: string;
  expiresAt: number;
  createdAt: number;
}

export interface AutomationInfo {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  sessionId: string;
  createdAt: number;
}

export interface CaptureMeta {
  messageId: string;
  seq: number;
  provider: string;
  model: string;
  status: number | null;
  createdAt: number;
}
export interface CaptureDetail {
  sessionId: string;
  messageId: string;
  provider: string;
  model: string;
  request: unknown;
  responseMeta: { status: number; headers: Record<string, string> } | null;
  responseMsg: unknown;
  createdAt: number;
}
export interface ReplayResult {
  ok: boolean;
  status: number;
  response: unknown;
  outputText: string | null;
  errorMessage: string | null;
}

export interface FilePreviewSource {
  url: string;
  size: number;
  version: string;
  mimeType: string;
  expiresAt: number;
  expiresInMs?: number;
}

export { getToken, setToken } from "./token.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NETWORK_RETRY_BACKOFF_MS = [150, 500];

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getToken();
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= NETWORK_RETRY_BACKOFF_MS.length; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api" + path, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      if (attempt < NETWORK_RETRY_BACKOFF_MS.length) {
        await sleep(NETWORK_RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      logClient("api_network_error", transportDetail(e), { path: `${method} ${path}` });
      throw new NetworkError(e);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = json as { error?: string; banned?: boolean; reason?: string };
      throw new ApiError(
        body.error || `${res.status} ${res.statusText}`,
        res.status,
        body.banned === true,
        body.reason ?? null,
      );
    }
    return json as T;
  }
  throw lastErr;
}

export type AuthResult =
  | { state: "FULL_APP"; token: string; user: UserInfo }
  | { state: "PENDING_VERIFY"; emailVerificationPending: true; pendingEmail: string; message: string };

export const api = {
  signup: (email: string, password: string) =>
    req<AuthResult>("POST", "/auth/signup", { email, password }),
  login: (email: string, password: string) =>
    req<AuthResult>("POST", "/auth/login", { email, password }),
  logout: () => req<Record<string, never>>("POST", "/auth/logout"),
  verifyCode: (email: string, code: string) =>
    req<{ state: "FULL_APP"; token: string; user: UserInfo }>("POST", "/auth/verify-code", { email, code }),
  resendVerification: (email: string) => req<{ ok: boolean }>("POST", "/auth/verify/resend", { email }),
  forgotPassword: (email: string) => req<{ ok: boolean }>("POST", "/auth/forgot", { email }),
  resetPassword: (email: string, code: string, password: string) =>
    req<{ state: "FULL_APP"; token: string; user: UserInfo }>("POST", "/auth/reset", { email, code, password }),
  me: () => req<{ user: UserInfo }>("GET", "/me"),
  changePassword: async (currentPassword: string, newPassword: string, stepupToken?: string): Promise<void> => {
    const res = await req<{ ok: boolean; token: string }>("POST", "/auth/change-password", { currentPassword, newPassword, stepupToken });
    if (res.token) setToken(res.token);
  },
  githubStepupUrl: () => req<{ url: string }>("GET", "/auth/github/stepup"),
  stepupUrl: () => req<{ url: string }>("GET", "/auth/stepup"),

  providers: () => req<{ providers: string[]; keys: ProviderKeyInfo[] }>("GET", "/providers"),
  setKey: (provider: string, key: string) => req<{ ok: boolean }>("PUT", `/providers/${provider}/key`, { key }),
  deleteKey: (provider: string) => req<{ ok: boolean }>("DELETE", `/providers/${provider}/key`),
  models: () => req<ModelsResponse>("GET", "/models"),

  orcaProvider: () => req<OrcaProviderInfo>("GET", "/providers/orcarouter"),
  orcaModels: (modality: "text" | "image" = "text") =>
    req<OrcaModelCatalog>("GET", `/providers/orcarouter/models?modality=${modality}`),
  orcaSaveKey: (key: string) =>
    req<{ ok: boolean; hint: string; generation: number; source: "api_key" }>("PUT", "/providers/orcarouter/key", { key }),
  orcaClearKey: () => req<{ ok: boolean }>("DELETE", "/providers/orcarouter/key"),
  orcaLoginStart: () =>
    req<{ ok: boolean; attemptId: string; url: string; expiresAt: number }>("POST", "/providers/orcarouter/login/start", {}),
  orcaLoginComplete: (attemptId: string, code: string) =>
    req<{ ok: boolean; hint: string; scope: string; generation: number; source: "oauth_pkce" }>(
      "POST",
      "/providers/orcarouter/login/complete",
      { attemptId, code },
    ),
  orcaLoginCancel: (attemptId: string) =>
    req<{ ok: boolean; cancelled: boolean }>("POST", "/providers/orcarouter/login/cancel", { attemptId }),
  /** Fire-and-forget cancel that survives the page being hidden or torn down. */
  orcaLoginCancelKeepalive: (attemptId: string) => {
    const token = getToken();
    void fetch("/api/providers/orcarouter/login/cancel", {
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({ attemptId }),
    }).catch(() => {});
  },

  memory: () => req<{ enabled: boolean; state: string; userNotes: string; lastDreamedAt: number | null }>("GET", "/settings/memory"),
  setMemory: (patch: { enabled?: boolean; userNotes?: string }) =>
    req<{ ok: boolean; enabled: boolean; userNotes: string }>("PATCH", "/settings/memory", patch),
  clearMemoryState: () => req<{ ok: boolean }>("DELETE", "/settings/memory/state"),

  egress: () => req<{ proxyUrl: string; jumpServer: string }>("GET", "/settings/egress"),
  setEgress: (proxyUrl: string, jumpServer: string) =>
    req<{ ok: boolean; proxyUrl: string; jumpServer: string; proxyApplies: boolean }>(
      "PATCH",
      "/settings/egress",
      { proxyUrl, jumpServer },
    ),

  search: (q: string) => req<SearchResponse>("GET", `/search?q=${encodeURIComponent(q)}`),

  sshTargets: () => req<{ enabled: boolean; targets: SshTargetInfo[] }>("GET", "/ssh/targets"),
  createSshTarget: (
    body: { label: string; host: string; port: number; username: string } & (
      | { privateKey: string }
      | { wrappedKey: unknown }
    ),
  ) => req<{ ok: boolean; target: SshTargetInfo }>("POST", "/ssh/targets", body),
  deleteSshTarget: (id: string) => req<{ ok: boolean }>("DELETE", `/ssh/targets/${id}`),
  testSshTarget: (id: string) =>
    req<{ ok: boolean; output?: string; error?: string; needsUnlock?: boolean }>("POST", `/ssh/targets/${id}/test`),
  sshTargetWrapped: (id: string) => req<{ wrappedKey: WrappedKey }>("GET", `/ssh/targets/${id}/wrapped`),
  unlockSshTarget: (id: string, privateKey: string) =>
    req<{ ok: boolean; expiresAt: number }>("POST", `/ssh/targets/${id}/unlock`, { privateKey }),
  lockSshTarget: (id: string) => req<{ ok: boolean }>("POST", `/ssh/targets/${id}/lock`),
  webauthnCredentials: () => req<{ credentials: WebauthnCredentialInfo[] }>("GET", "/webauthn/credentials"),
  addWebauthnCredential: (body: { credentialId: string; label: string; transports: string[] }) =>
    req<{ ok: boolean; credential: WebauthnCredentialInfo }>("POST", "/webauthn/credentials", body),
  deleteWebauthnCredential: (id: string) => req<{ ok: boolean }>("DELETE", `/webauthn/credentials/${id}`),

  connectors: () => req<{ connectors: ConnectorInfo[] }>("GET", "/connectors"),
  connectorTelemetry: (id: string, signal?: AbortSignal) =>
    req<{ telemetry: ConnectorTelemetry }>("GET", `/connectors/${id}/telemetry`, undefined, signal),
  createConnectorPairing: (body: { name: string; workspaceRoot: string }) =>
    req<{ ok: boolean; pairing: ConnectorPairingInfo; code: string }>("POST", "/connectors/pairings", body),
  createConnector: (body: { name: string; workspaceRoot: string }) =>
    req<{ ok: boolean; connector: ConnectorInfo; token: string }>("POST", "/connectors", body),
  deleteConnector: (id: string) => req<{ ok: boolean }>("DELETE", `/connectors/${id}`),
  setConnectorUnconfined: (id: string, unconfined: boolean) =>
    req<{ ok: boolean; unconfined: boolean }>("PATCH", `/connectors/${id}`, { unconfined }),
  setSshUnconfined: (id: string, unconfined: boolean) =>
    req<{ ok: boolean; unconfined: boolean }>("PATCH", `/ssh-targets/${id}`, { unconfined }),
  testConnector: (id: string) =>
    req<{ ok: boolean; output?: string; error?: string }>("POST", `/connectors/${id}/test`),

  automations: () => req<{ automations: AutomationInfo[] }>("GET", "/automations"),
  createAutomation: (body: { name: string; prompt: string; intervalMinutes: number }) =>
    req<{ automation: AutomationInfo }>("POST", "/automations", body),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    req<{ automation: AutomationInfo }>("PATCH", `/automations/${id}`, { enabled }),
  deleteAutomation: (id: string) => req<{ ok: boolean }>("DELETE", `/automations/${id}`),
  runAutomation: (id: string) => req<{ ok: boolean }>("POST", `/automations/${id}/run-now`),

  sessions: () => req<{ sessions: SessionInfo[] }>("GET", "/sessions"),
  createSession: (input: {
    title: string;
    provider: string;
    model: string;
    sandboxMode: SandboxMode;
    sandboxKind?: SandboxKind;
    sandboxTargetId?: string | null;
    mode?: SessionMode;
    approvalPolicy: ApprovalPolicy;
    connectorUnconfined?: boolean;
  }) => req<{ session: SessionInfo }>("POST", "/sessions", input),
  session: (id: string) => req<{ session: SessionInfo }>("GET", `/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    req<{ session: SessionInfo }>("PATCH", `/sessions/${id}`, { title }),
  setThinkingLevel: (id: string, thinkingLevel: ThinkingLevel) =>
    req<{ session: SessionInfo }>("PATCH", `/sessions/${id}`, { thinkingLevel }),
  setModel: (id: string, provider: string, model: string) =>
    req<{ session: SessionInfo }>("PATCH", `/sessions/${id}`, { provider, model }),
  setApprovalPolicy: (id: string, approvalPolicy: ApprovalPolicy) =>
    req<{ session: SessionInfo }>("PATCH", `/sessions/${id}`, { approvalPolicy }),
  deleteSession: (id: string) => req<{ ok: boolean }>("DELETE", `/sessions/${id}`),
  forkSession: (id: string, fromSeq: number) =>
    req<{ session: SessionInfo }>("POST", `/sessions/${id}/fork`, { fromSeq }),
  timeline: (id: string) =>
    req<{ epoch: string; items: TimelineItem[]; status: string }>("GET", `/sessions/${id}/timeline`),

  sessionRunSnapshot: (
    id: string,
    cursors: { agentCursor?: string; taskCursor?: string } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (cursors.agentCursor) params.set("agentCursor", cursors.agentCursor);
    if (cursors.taskCursor) params.set("taskCursor", cursors.taskCursor);
    const query = params.size ? `?${params}` : "";
    return req<SessionRunSnapshot>("GET", `/sessions/${encodeURIComponent(id)}/run${query}`, undefined, signal);
  },
  orchestrationActivitySnapshot: (cursor?: string, signal?: AbortSignal) =>
    req<OrchestrationActivityPage>(
      "GET",
      `/orchestration/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      undefined,
      signal,
    ),
  orchestrationWorkflowList: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size ? `?${params}` : "";
    return req<WorkflowListPage>("GET", `/orchestration/workflows${query}`, undefined, signal);
  },
  orchestrationWorkflowDetail: (id: string, signal?: AbortSignal) =>
    req<{ workflow: WorkflowReadDetail }>(
      "GET",
      `/orchestration/workflows/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  orchestrationTeamList: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size ? `?${params}` : "";
    return req<TeamListPage>("GET", `/orchestration/teams${query}`, undefined, signal);
  },
  orchestrationTeamDetail: (id: string, signal?: AbortSignal) =>
    req<{ team: TeamReadDetail }>(
      "GET",
      `/orchestration/teams/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  orchestrationTeamMail: (
    id: string,
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size ? `?${params}` : "";
    return req<OrchestrationPage<TeamMailListItem>>(
      "GET",
      `/orchestration/teams/${encodeURIComponent(id)}/mail${query}`,
      undefined,
      signal,
    );
  },
  orchestrationTeamMailDetail: (id: string, mailId: string, signal?: AbortSignal) =>
    req<{ mail: TeamMailReadDetail }>(
      "GET",
      `/orchestration/teams/${encodeURIComponent(id)}/mail/${encodeURIComponent(mailId)}`,
      undefined,
      signal,
    ),
  orchestrationAgentDetail: (id: string, signal?: AbortSignal) =>
    req<{ agent: AgentReadDetail }>(
      "GET",
      `/orchestration/agents/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  orchestrationTaskDetail: (id: string, signal?: AbortSignal) =>
    req<{ task: RuntimeTaskReadDetail }>(
      "GET",
      `/orchestration/tasks/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  orchestrationTaskResult: (id: string, signal?: AbortSignal) =>
    req<{ result: TaskResultReadDetail }>(
      "GET",
      `/orchestration/tasks/${encodeURIComponent(id)}/result`,
      undefined,
      signal,
    ),

  getCompaction: (sessionId: string, cid: string) =>
    req<CompactionDetailResponse>("GET", `/sessions/${sessionId}/compactions/${cid}`),

  createShare: (sessionId: string, scope?: { itemIds: string[] }) =>
    req<{ token: string; url: string; createdAt: number; itemCount: number }>(
      "POST",
      `/sessions/${sessionId}/share`,
      scope ? { scope } : undefined,
    ),
  listShares: (sessionId: string) =>
    req<{ shares: { token: string; url: string; createdAt: number }[] }>("GET", `/sessions/${sessionId}/shares`),
  revokeShare: (token: string) => req<{ ok: boolean }>("DELETE", `/share/${token}`),

  files: (id: string, path: string) =>
    req<{ entries: FileEntry[] }>("GET", `/sessions/${id}/files?path=${encodeURIComponent(path)}`),
  diff: (id: string) => req<WorkspaceDiff>("GET", `/sessions/${id}/diff`),
  readFile: (id: string, path: string) =>
    req<{ path: string; content: string; size: number; binary: boolean }>(
      "GET",
      `/sessions/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  downloadFile: async (id: string, path: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`/api/sessions/${id}/download?path=${encodeURIComponent(path)}`, {
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; banned?: boolean; reason?: string };
      throw new ApiError(body.error || `${res.status} ${res.statusText}`, res.status, body.banned === true, body.reason ?? null);
    }
    const blob = await res.blob();
    const name = path.split("/").pop() || "file";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  downloadAllFiles: async (id: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`/api/sessions/${id}/download-all`, {
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; banned?: boolean; reason?: string };
      throw new ApiError(body.error || `${res.status} ${res.statusText}`, res.status, body.banned === true, body.reason ?? null);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const name = /filename="?([^"]+)"?/.exec(cd)?.[1] || `workspace-${id}.tar.gz`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  filePreviewSource: (id: string, path: string, purpose?: "full-viewer") =>
    req<FilePreviewSource>("POST", `/sessions/${id}/file-preview`, { path, ...(purpose ? { purpose } : {}) }),
  upload: (
    id: string,
    files: { name: string; dataBase64: string }[],
    onProgress?: (fraction: number) => void,
  ): Promise<{ files: { name: string; path: string; bytes: number }[]; userTotalBytes: number; quotaBytes: number }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/sessions/${id}/upload`);
      const token = getToken();
      if (token) xhr.setRequestHeader("authorization", "Bearer " + token);
      xhr.setRequestHeader("content-type", "application/json");
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.total > 0 ? e.loaded / e.total : 0);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("malformed upload response"));
          }
        } else {
          let msg = `${xhr.status} ${xhr.statusText}`;
          let banned = false;
          let reason: string | null = null;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body && typeof body.error === "string") msg = body.error;
            banned = body?.banned === true;
            reason = typeof body?.reason === "string" ? body.reason : null;
          } catch {
          }
          reject(new ApiError(msg, xhr.status, banned, reason));
        }
      };
      xhr.onerror = () => reject(new Error("network error during upload"));
      xhr.send(JSON.stringify({ files }));
    }),

  adminCaptures: (sessionId: string) =>
    req<{ captures: CaptureMeta[] }>("GET", `/admin/sessions/${sessionId}/captures`),
  adminCapture: (sessionId: string, messageId: string) =>
    req<CaptureDetail>("GET", `/admin/sessions/${sessionId}/captures/${encodeURIComponent(messageId)}`),
  adminReplay: (sessionId: string, messageId: string, request: unknown) =>
    req<ReplayResult>("POST", `/admin/sessions/${sessionId}/captures/${encodeURIComponent(messageId)}/replay`, { request }),
};
