import crypto from "node:crypto";
import { errorMessage } from "../foundation/errors.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type Model,
  type Context,
  type Message,
  type AssistantMessage,
  type ToolCall,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider, getModel, getModels } from "@earendil-works/pi-ai/compat";
import { isThinkingLevel, OPERATOR_MODEL_PROVIDER, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../../../shared/src/protocol.ts";
import { keyDao } from "../persistence/index.ts";
import { decryptKey } from "../identity/auth.ts";
import { PRODUCT_NAME } from "../config.ts";
import { ORCAROUTER_PROVIDER, orcaCatalogSnapshot, toOrcaModel, toOrcaModelInfo } from "./orcarouter.ts";

const BASE_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];

export const MOCK_API = "mock";
export const MOCK_PROVIDER = "mock";
export const MOCK_MODEL_ID = "mock-coder";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const mockModel: Model<string> = {
  id: MOCK_MODEL_ID,
  name: "Mock Coder (offline, keyless)",
  api: MOCK_API,
  provider: MOCK_PROVIDER,
  baseUrl: "http://localhost:0",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

function lastText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

function newToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: "tc_" + crypto.randomUUID(), name, arguments: args };
}

function asAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MOCK_API,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

const OIIA_NOW_RE = /\u2060<(?:o11n|oiia)-now>[\s\S]*?<\/(?:o11n|oiia)-now>\u2060/g;

function computeMockResponse(context: Context): AssistantMessage {
  const messages = context.messages;
  const last = messages[messages.length - 1];

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  const lastUserText = lastUserIdx === -1 ? "" : lastText(messages[lastUserIdx].content).replace(OIIA_NOW_RE, "").trim();
  if (lastUserText === "/steps") {
    const stepsDone = messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult").length;
    const steps = [
      () => newToolCall("bash", { command: "mkdir -p steps-demo" }),
      () => newToolCall("bash", { command: "true" }),
      () => newToolCall("list_files", { path: "." }),
    ];
    if (stepsDone < steps.length) {
      return asAssistant(
        [
          { type: "thinking", thinking: `Planning step ${stepsDone + 1} of ${steps.length}.` },
          steps[stepsDone](),
        ],
        "toolUse",
      );
    }
  }

  if (last && last.role === "toolResult") {
    let calls: ToolCall[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
        break;
      }
    }
    const results = messages.filter((m) => m.role === "toolResult").slice(-calls.length || -1);
    const diagramCall = calls.find((call) => call.name === "diagram_lint");
    if (diagramCall) {
      const resultText = results.map((result) => lastText(result.content)).join("\n");
      const args = diagramCall.arguments as Record<string, unknown>;
      const language = String(args.language ?? "");
      const source = String(args.source ?? "");
      if (resultText.startsWith("VALID ") && (language === "mermaid" || language === "d2")) {
        return asAssistant([{ type: "text", text: `Compiler passed.\n\n\`\`\`${language}\n${source}\n\`\`\`` }], "stop");
      }
      return asAssistant([{ type: "text", text: `The diagram compiler rejected the source:\n\n${resultText}` }], "stop");
    }
    const phrases: string[] = [];
    for (const c of calls) {
      const a = c.arguments as Record<string, unknown>;
      if (c.name === "write_file") phrases.push(`wrote \`${a.path}\``);
      else if (c.name === "edit_file") phrases.push(`edited \`${a.path}\``);
      else if (c.name === "read_file") phrases.push(`read \`${a.path}\``);
      else if (c.name === "list_files") phrases.push(`listed \`${a.path ?? "."}\``);
      else if (c.name === "bash") phrases.push(`ran \`${String(a.command).slice(0, 60)}\``);
      else if (c.name === "canvas") phrases.push("rendered a canvas card");
      else if (c.name === "spawn_subagent") phrases.push(`delegated a task to a subagent`);
      else if (c.name === "team_create") phrases.push("created a Team");
      else if (c.name === "team_assign") phrases.push("assigned Team work");
      else if (c.name === "team_mail") phrases.push("used Team mail");
      else if (c.name.startsWith("mcp__")) phrases.push(`called MCP tool \`${c.name}\``);
      else phrases.push(c.name);
    }
    const blocked = results.some((r) => (r as any).isError);
    let summary = phrases.length ? `Done. I ${phrases.join(", ")}.` : "Done.";
    if (blocked) summary = `Some actions could not complete (denied or errored). I ${phrases.join(", ")}.`;
    return asAssistant(
      [
        { type: "thinking", thinking: "The tool results are in; summarizing the outcome for the user." },
        { type: "text", text: summary },
      ],
      "stop",
    );
  }

  const text = (last && last.role === "user" ? lastText(last.content) : "").replace(OIIA_NOW_RE, "");
  const trimmed = text.trim();

  const mk = (intro: string, call: ToolCall) =>
    asAssistant([{ type: "text", text: intro }, call], "toolUse");

  const assignTeam = (directive: string): AssistantMessage => {
    const [header = "", titleLine = "", ...payloadLines] = directive.split("\n");
    const [teamId = "", targetMemberId = ""] = header
      .slice("/team-assign ".length)
      .trim()
      .split(/\s+/, 2);
    const rawPayload = payloadLines.join("\n").trim();
    let payload: unknown = { request: titleLine.trim() || "Complete the assignment." };
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = { request: rawPayload };
      }
    }
    return mk(
      `Assigning Team work \`${titleLine.trim() || "work"}\`.`,
      newToolCall("team_assign", {
        teamId,
        targetMemberId,
        title: titleLine.trim() || "Team work",
        payload,
      }),
    );
  };

  if (trimmed.startsWith("<team_assignment>")) {
    const encoded = /Assignment data:\n([^\n]+)\n<\/team_assignment>/.exec(trimmed)?.[1];
    if (encoded) {
      try {
        const assignment = JSON.parse(encoded) as { request?: unknown };
        if (typeof assignment.request === "string" && assignment.request.startsWith("/team-assign ")) {
          return assignTeam(assignment.request);
        }
      } catch {
      }
    }
  }

  if (trimmed.startsWith("/bash ")) {
    const cmd = trimmed.slice(6).trim();
    return mk(`Running: \`${cmd}\``, newToolCall("bash", { command: cmd }));
  }
  if (trimmed.startsWith("/write ")) {
    const rest = trimmed.slice(7);
    const nl = rest.indexOf("\n");
    const path = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    const body = nl === -1 ? "" : rest.slice(nl + 1);
    return mk(`Creating \`${path}\``, newToolCall("write_file", { path, content: body }));
  }
  if (trimmed.startsWith("/edit ")) {
    const rest = trimmed.slice(6);
    const nl = rest.indexOf("\n");
    const path = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    const bodyRaw = nl === -1 ? "" : rest.slice(nl + 1);
    const [oldStr, newStr] = bodyRaw.split("\n>>>\n");
    return mk(`Editing \`${path}\``, newToolCall("edit_file", { path, old: oldStr ?? "", new: newStr ?? "" }));
  }
  if (trimmed.startsWith("/read ")) {
    const path = trimmed.slice(6).trim();
    return mk(`Reading \`${path}\``, newToolCall("read_file", { path }));
  }
  if (trimmed.startsWith("/ls")) {
    const path = trimmed.slice(3).trim() || ".";
    return mk(`Listing \`${path}\``, newToolCall("list_files", { path }));
  }
  if (trimmed.startsWith("/link ")) {
    const path = trimmed.slice(6).trim();
    return asAssistant(
      [{ type: "text", text: `Here is the file:\n\n[${path}](${path})\n\nAlso see [the docs](https://example.com/docs).` }],
      "stop",
    );
  }
  if (trimmed.startsWith("/say ")) {
    return asAssistant([{ type: "text", text: trimmed.slice("/say ".length) }], "stop");
  }
  if (trimmed === "/burst") {
    return asAssistant(
      [
        newToolCall("bash", { command: "mkdir -p burst-demo" }),
        newToolCall("bash", { command: "true" }),
        newToolCall("list_files", { path: "." }),
        newToolCall("bash", { command: "echo BURST_VISIBLE_OUTPUT" }),
        newToolCall("write_file", { path: "burst-demo/note.txt", content: "burst demo\n" }),
      ],
      "toolUse",
    );
  }
  if (trimmed === "/mermaid") {
    return asAssistant(
      [{
        type: "text",
        text: [
          "```mermaid",
          "flowchart LR",
          "  API[Backend HTTP API] --> Q{Read type?}",
          "  Q -->|Realtime weights| DNS[DNSPod: DescribeRecordList]",
          "  Q -->|Trend analysis| MYSQL[(MySQL: t_cdn_weight)]",
          "  Q -->|Vendor compare| SNAP[Snapshot comparison table]",
          "  DNS --> RESULT[Realtime weight result]",
          "  MYSQL --> RESULT",
          "  SNAP --> RESULT",
          "  RESULT --> UI[User / frontend page]",
          "```",
        ].join("\n"),
      }],
      "stop",
    );
  }
  if (trimmed === "/d2") {
    return asAssistant(
      [{
        type: "text",
        text: [
          "```d2",
          "direction: right",
          "client: 客户端",
          "gateway: API Gateway",
          "worker: Worker",
          "store: Database {shape: cylinder}",
          "client -> gateway: request",
          "gateway -> worker: dispatch",
          "worker -> store: persist",
          "store -> client: result",
          "```",
        ].join("\n"),
      }],
      "stop",
    );
  }
  if (trimmed === "/talld2") {
    const lines = ["direction: down", ...Array.from({ length: 13 }, (_, index) => `n${index + 1}: Step ${index + 1}`)];
    for (let index = 1; index < 13; index++) lines.push(`n${index} -> n${index + 1}`);
    return asAssistant([{ type: "text", text: `\`\`\`d2\n${lines.join("\n")}\n\`\`\`` }], "stop");
  }
  if (trimmed === "/tallmermaid") {
    const edges = Array.from({ length: 12 }, (_, index) => `  N${index + 1}[Step ${index + 1}] --> N${index + 2}[Step ${index + 2}]`);
    return asAssistant([{ type: "text", text: `\`\`\`mermaid\nflowchart TD\n${edges.join("\n")}\n\`\`\`` }], "stop");
  }
  if (trimmed === "/lintd2") {
    const source = [
      "direction: right",
      "input: 输入",
      "lint: Compiler / lint",
      "output: Rendered D2",
      "input -> lint: exact source",
      "lint -> output: valid",
    ].join("\n");
    return mk("Validating the exact D2 source before display.", newToolCall("diagram_lint", { language: "d2", source }));
  }
  if (trimmed === "/lintd2unsafe") {
    const source = [
      "unsafe: External media {",
      "  icon: https://example.invalid/diagram-icon.svg",
      "  link: https://example.invalid/diagram-target",
      "}",
      "markup: |md",
      "  <img src=\"https://example.invalid/markdown.png\" onerror=\"alert(1)\" />",
      "  <style>@import url(https://example.invalid/markdown.css);</style>",
      "  <script>alert(1)</script>",
      "|",
    ].join("\n");
    return mk("Validating the exact D2 source before display.", newToolCall("diagram_lint", { language: "d2", source }));
  }
  if (trimmed === "/badlintd2") {
    return mk("Validating the exact D2 source before display.", newToolCall("diagram_lint", { language: "d2", source: "a ->" }));
  }
  if (trimmed === "/canvas") {
    const html = [
      `<div style="font-family:-apple-system,'PingFang SC',sans-serif;padding:22px 26px;background:#ffffff;color:#1a1a1a;border-radius:12px;border:1px solid rgba(0,0,0,0.07)">`,
      `<div style="font-size:16px;font-weight:700;margin-bottom:14px">landing 页改版 · 发布检查单</div>`,
      ...[
        ["新配色已应用", "12 个组件"],
        ["文案全部替换", "8 处"],
        ["测试通过", "42 / 42"],
        ["构建产物", "1.2 MB · -18%"],
      ].map(
        ([k, v]) =>
          `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14px">` +
          `<span style="width:18px;height:18px;border-radius:9px;background:#12b76a;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px">✓</span>` +
          `<span style="flex:1">${k}</span><span style="color:#8a8a8a">${v}</span></div>`,
      ),
      `<div style="margin-top:12px;font-size:12px;color:#9a9a9a">由 ${PRODUCT_NAME} 生成 · 卡片可交互</div>`,
      `</div>`,
    ].join("");
    return mk("Rendering a release checklist card.", newToolCall("canvas", { title: "发布检查单", html, height: 320 }));
  }
  if (trimmed === "/badmermaid") {
    return asAssistant(
      [{ type: "text", text: "```mermaid\nflowchart LR\n  A -->\n```" }],
      "stop",
    );
  }
  if (trimmed === "/badd2") {
    return asAssistant([{ type: "text", text: "```d2\na ->\n```" }], "stop");
  }
  if (trimmed.startsWith("/subagent ") || trimmed.startsWith("/team ")) {
    const task = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    return mk(`Delegating to a subagent: "${task.split("\n")[0]}"`, newToolCall("spawn_subagent", { task }));
  }
  if (trimmed.startsWith("/team-create ")) {
    const [header = "", ...roleLines] = trimmed.split("\n");
    const name = header.slice("/team-create ".length).trim();
    const roles = roleLines.map((role) => role.trim()).filter(Boolean).map((role) => ({ role }));
    return mk(
      `Creating Team \`${name}\`.`,
      newToolCall("team_create", { name, roles: roles.length > 0 ? roles : [{ role: "worker" }] }),
    );
  }
  if (trimmed.startsWith("/team-assign ")) {
    return assignTeam(trimmed);
  }
  if (trimmed === "/team-list" || trimmed.startsWith("/team-list ")) {
    const teamId = trimmed.slice("/team-list".length).trim();
    return mk(
      teamId ? `Reading Team \`${teamId}\`.` : "Listing Teams.",
      newToolCall("team_mail", {
        action: "list",
        ...(teamId ? { teamId } : {}),
      }),
    );
  }
  if (trimmed.startsWith("/agent ")) {
    const [header = "", ...body] = trimmed.split("\n");
    const taskName = header.slice("/agent ".length).trim();
    const message = body.join("\n").trim();
    return mk(
      `Starting background Agent \`${taskName}\`.`,
      newToolCall("spawn_agent", { task_name: taskName, message, context: "recent" }),
    );
  }
  if (trimmed.startsWith("/mcp ")) {
    const text = trimmed.slice(5).trim();
    return mk(`Calling MCP tool \`echo\``, newToolCall("mcp__demo__echo", { text }));
  }
  if (/\blist\b.*\bfile/i.test(trimmed) || /what.*files/i.test(trimmed)) {
    return mk("Let me look at the workspace.", newToolCall("list_files", { path: "." }));
  }

  return asAssistant(
    [
      {
        type: "text",
        text:
          "I'm the offline **Mock Coder** model (no API key needed). I can drive real tools in your sandbox. Try:\n" +
          "- `/bash <command>` — run a shell command\n" +
          "- `/write <path>` then a newline and the file contents\n" +
          "- `/read <path>` — read a file\n" +
          "- `/ls [path]` — list files\n" +
          "- `/edit <path>` then `<old>` `>>>` `<new>` on separate lines\n" +
          "- `/subagent <task>` (or `/team`) — delegate a task to a subagent\n\n" +
          "- `/agent <name>` then a newline and task — start an addressable background Agent\n\n" +
          "Add a real provider API key in Settings to use Claude, GPT, Gemini, and more.",
      },
    ],
    "stop",
  );
}

function chunk(text: string, size = 18): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

function streamToolArgs(full: Record<string, unknown>): { delta: string; args: Record<string, unknown> }[] {
  const keys = Object.keys(full);
  const bigKey = keys
    .filter((k) => typeof full[k] === "string")
    .sort((a, b) => String(full[b]).length - String(full[a]).length)[0];
  const ordered = bigKey ? [...keys.filter((k) => k !== bigKey), bigKey] : keys;

  const steps: { delta: string; args: Record<string, unknown> }[] = [];
  const acc: Record<string, unknown> = {};
  let prevJson = "";
  const emit = () => {
    const json = JSON.stringify(acc);
    const delta = json.startsWith(prevJson) ? json.slice(prevJson.length) : json;
    prevJson = json;
    steps.push({ delta, args: { ...acc } });
  };

  for (const k of ordered) {
    const v = full[k];
    if (k === bigKey && typeof v === "string" && v.length > 0) {
      let revealed = "";
      for (const piece of chunk(v, Math.max(8, Math.ceil(v.length / 4)))) {
        revealed += piece;
        acc[k] = revealed;
        emit();
      }
    } else {
      acc[k] = v;
      emit();
    }
  }
  if (steps.length === 0) {
    steps.push({ delta: "{}", args: {} });
  }
  return steps;
}

const mockStream = (_model: Model<string>, context: Context, options?: StreamOptions) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const signal = options?.signal;
    try {
      await options?.onPayload?.(context, _model);
      const message = computeMockResponse(context);
      await options?.onResponse?.({ status: 200, headers: { "content-type": "application/json" } }, _model);
      const partial: AssistantMessage = { ...message, content: [] };
      stream.push({ type: "start", partial: { ...partial } });
      for (let i = 0; i < message.content.length; i++) {
        if (signal?.aborted) {
          const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "aborted" };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
          return;
        }
        const block = message.content[i];
        if (block.type === "thinking") {
          partial.content = [...partial.content, { type: "thinking", thinking: "" }];
          stream.push({ type: "thinking_start", contentIndex: i, partial: { ...partial } });
          for (const c of chunk(block.thinking)) {
            await delay(4);
            (partial.content[i] as any).thinking += c;
            stream.push({ type: "thinking_delta", contentIndex: i, delta: c, partial: { ...partial } });
          }
          stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: { ...partial } });
        } else if (block.type === "text") {
          partial.content = [...partial.content, { type: "text", text: "" }];
          stream.push({ type: "text_start", contentIndex: i, partial: { ...partial } });
          for (const c of chunk(block.text)) {
            await delay(4);
            (partial.content[i] as any).text += c;
            stream.push({ type: "text_delta", contentIndex: i, delta: c, partial: { ...partial } });
          }
          stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: { ...partial } });
        } else {
          partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
          stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...partial } });
          let streamedArgumentSteps = 0;
          for (const step of streamToolArgs(block.arguments)) {
            if (signal?.aborted) break;
            await delay(6);
            (partial.content[i] as any).arguments = step.args;
            stream.push({ type: "toolcall_delta", contentIndex: i, delta: step.delta, partial: { ...partial } });
            streamedArgumentSteps++;
            if (
              streamedArgumentSteps === 1 &&
              block.name === "write_file" &&
              process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR === "1"
            ) {
              const failed = {
                ...partial,
                stopReason: "error" as const,
                errorMessage: "mock partial tool stream failure",
              };
              stream.push({ type: "error", reason: "error", error: failed });
              stream.end(failed);
              return;
            }
          }
          (partial.content[i] as any).arguments = block.arguments;
          stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: { ...partial } });
          const commitDelayMs = Math.min(5_000, Math.max(0, Number(process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS) || 0));
          if (commitDelayMs > 0) await delay(commitDelayMs);
          if (signal?.aborted) {
            const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "aborted" };
            stream.push({ type: "error", reason: "aborted", error: aborted });
            stream.end(aborted);
            return;
          }
        }
      }
      stream.push({ type: "done", reason: message.stopReason as any, message });
      stream.end(message);
    } catch (err) {
      const m = asAssistant([], "error");
      m.errorMessage = errorMessage(err);
      stream.push({ type: "error", reason: "error", error: m });
      stream.end(m);
    }
  });
  return stream;
};

let registered = false;
export function registerMockProvider(): void {
  if (registered) return;
  registerApiProvider({ api: MOCK_API, stream: mockStream, streamSimple: mockStream }, "agent-web-mock");
  registered = true;
}

const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "openrouter",
  "kimi-coding",
  "orcarouter",
] as const;

export function knownProviders(): string[] {
  return [...KNOWN_PROVIDERS];
}

type AppModel = Model<any> & { compactAt?: number };

export const JAIL_PROVIDER = OPERATOR_MODEL_PROVIDER;
export const JAIL_BASE_URL = process.env.AGENT_WEB_JAIL_BASE_URL || "";
export const JAIL_API = (process.env.AGENT_WEB_JAIL_API || "openai-responses") as Model<any>["api"];
export const JAIL_MODEL_ID = process.env.AGENT_WEB_JAIL_MODEL?.trim() || "";

function configuredJailModelIds(): string[] {
  const extra = (process.env.AGENT_WEB_JAIL_MODELS ?? "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 128);
  return [...new Set([JAIL_MODEL_ID, ...extra])];
}

export const JAIL_MODEL_IDS = configuredJailModelIds();

function jailModelName(id: string): string {
  for (const pair of (process.env.AGENT_WEB_JAIL_MODEL_NAMES ?? "").split(",")) {
    const [key, name] = pair.split("=");
    if (key?.trim() === id && name?.trim()) return name.trim();
  }
  return id;
}

function jailModel(id: string): AppModel {
  return {
    id,
    name: jailModelName(id),
    api: JAIL_API,
    provider: JAIL_PROVIDER,
    baseUrl: JAIL_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    compactAt: 252_000,
    headers: { "User-Agent": "oiia/1.0" },
    ...(jailModelExtraLevels(id).length > 0
      ? { thinkingLevelMap: Object.fromEntries(jailModelExtraLevels(id).map((l) => [l, l])) }
      : {}),
  };
}

const JAIL_MODELS: AppModel[] = JAIL_MODEL_IDS.map(jailModel);

export function jailAvailable(): boolean {
  return Boolean(process.env.AGENT_WEB_JAIL_KEY) && Boolean(JAIL_BASE_URL);
}

function modelThinkingLevels(m: Model<any>): ThinkingLevel[] | undefined {
  if (!m.reasoning) return undefined;
  const map = (m as { thinkingLevelMap?: Record<string, string | null | undefined> }).thinkingLevelMap;
  if (!map) return undefined;
  const extra = THINKING_LEVELS.filter((level) =>
    !BASE_THINKING_LEVELS.includes(level) && typeof map[level] === "string");
  if (extra.length === 0) return undefined;
  return [...BASE_THINKING_LEVELS, ...extra];
}

function jailModelExtraLevels(id: string): ThinkingLevel[] {
  for (const pair of (process.env.AGENT_WEB_JAIL_MODEL_LEVELS ?? "").split(";")) {
    const [key, list] = pair.split("=");
    if (key?.trim() !== id || !list) continue;
    return list.split(",").map((s) => s.trim()).filter(isThinkingLevel)
      .filter((l) => l !== "low" && l !== "medium" && l !== "high");
  }
  return [];
}

export function effectiveThinkingLevel(m: Model<any>, stored: string | null | undefined): ThinkingLevel | "off" {
  if (!m.reasoning) return "off";
  const asked: ThinkingLevel = isThinkingLevel(stored) ? stored : "medium";
  const supported = modelThinkingLevels(m) ?? BASE_THINKING_LEVELS;
  if (supported.includes(asked)) return asked;
  const rank = (l: ThinkingLevel) => THINKING_LEVELS.indexOf(l);
  const notStronger = supported.filter((level) => rank(level) <= rank(asked));
  return notStronger[notStronger.length - 1] ?? "medium";
}

function toModelInfo(m: Model<any>, mock = false): ModelInfo {
  const thinkingLevels = modelThinkingLevels(m);
  return {
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    mock,
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
}

export function listModelsForProviders(providersWithKeys: string[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  if (jailAvailable()) for (const m of JAIL_MODELS) out.push(toModelInfo(m));
  out.push(toModelInfo(mockModel, true));
  for (const provider of providersWithKeys) {
    if (!KNOWN_PROVIDERS.includes(provider as any)) continue;
    if (provider === ORCAROUTER_PROVIDER) {
      // OrcaRouter rows come from its own catalog, not from pi's bundled registry:
      // the seed is replaced outright by a live discovery response.
      for (const row of orcaCatalogSnapshot().models) out.push(toOrcaModelInfo(row));
      continue;
    }
    try {
      const models = getModels(provider as any);
      const cap = provider === "openrouter" ? 80 : Infinity;
      for (const m of models.slice(0, cap)) out.push(toModelInfo(m));
    } catch {
    }
  }
  return out;
}

export function resolveModel(provider: string, modelId: string): Model<any> {
  if (provider === MOCK_PROVIDER) return mockModel;
  if (provider === JAIL_PROVIDER) return JAIL_MODELS.find((m) => m.id === modelId) ?? JAIL_MODELS[0];
  if (provider === ORCAROUTER_PROVIDER) {
    const row = orcaCatalogSnapshot().models.find((m) => m.id === modelId);
    if (!row) throw new Error(`unknown OrcaRouter model: ${modelId}`);
    return toOrcaModel(row);
  }
  return getModel(provider as any, modelId as any);
}

export function apiKeyResolver(userId: string): (provider: string) => string | undefined {
  return (provider: string) => {
    if (provider === MOCK_PROVIDER) return undefined;
    if (provider === JAIL_PROVIDER) return process.env.AGENT_WEB_JAIL_KEY || undefined;
    const row = keyDao.get(userId, provider);
    if (!row) return undefined;
    try {
      return decryptKey(row.enc_key);
    } catch {
      return undefined;
    }
  };
}
