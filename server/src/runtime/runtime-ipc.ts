import http from "node:http";
import { errorMessage, errorCode } from "../foundation/errors.ts";
import fs from "node:fs";
import type { RuntimeClient } from "./manager.ts";

export const RUNTIME_PROTOCOL_VERSION = 5;
export function toError(e: unknown): Error { return e instanceof Error ? e : new Error(String(e)); }
const MAX_BODY = 64 * 1024 * 1024;

export const BOUNDED_OPS = [
  "createSession",
  "getExecutorAvailability",
  "listSessions",
  "getSessionInfo",
  "acknowledgeTaskResult",
  "isDraining",
  "liveSessionStatuses",
  "liveSessionActivities",
  "setThinkingLevel",
  "setApprovalPolicy",
  "setModel",
  "renameSession",
  "deleteSession",
  "releaseIfIdle",
  "refreshTargetRuntimes",
  "disposeUserRuntimes",
  "invalidateFilePreviewSandboxes",
  "rewind",
  "forkSession",
  "getSessionTimeline",
  "tryStartTurn",
  "writeUpload",
  "prepareFilePreview",
  "readFilePreviewChunk",
  "connectorList",
  "connectorTelemetry",
  "connectorCreatePairing",
  "connectorRedeemPairing",
  "connectorCreateToken",
  "connectorDelete",
  "connectorTestExec",
] as const;
export type BoundedOp = (typeof BOUNDED_OPS)[number];
const BOUNDED = new Set<string>(BOUNDED_OPS);

export type BoundedRuntimeClient = {
  [K in BoundedOp]: (
    ...args: Parameters<RuntimeClient[K]>
  ) => Promise<Awaited<ReturnType<RuntimeClient[K]>>>;
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export function createRuntimeHost(client: RuntimeClient, socketPath: string): http.Server {
  try {
    fs.unlinkSync(socketPath);
  } catch {
  }
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/runtime/hello") {
      return sendJson(res, 200, {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        draining: client.isDraining(),
        ts: Date.now(),
      });
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: unknown; args?: unknown };
        const method = parsed.method;
        const args = parsed.args ?? [];
        if (typeof method !== "string" || !BOUNDED.has(method)) {
          return sendJson(res, 400, { ok: false, error: `op not allowed: ${String(method)}` });
        }
        if (!Array.isArray(args)) {
          return sendJson(res, 400, { ok: false, error: "args must be an array" });
        }
        const result = await (client as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
          ...args,
        );
        sendJson(res, 200, { ok: true, result: result ?? null });
      } catch (e) {
        const code = errorCode(e);
        sendJson(res, 200, { ok: false, error: errorMessage(e), ...(code ? { code } : {}) });
      }
    });
  });
  server.listen(socketPath);
  return server;
}

export function makeRuntimeHttpClient(socketPath: string): BoundedRuntimeClient {
  const call = (method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify({ method, args });
      const req = http.request(
        {
          socketPath,
          path: "/rpc",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(body) as { ok: boolean; result?: unknown; error?: string; code?: string };
              if (j.ok) resolve(j.result);
              else {
                const err = new Error(j.error || `runtime rpc failed (HTTP ${res.statusCode})`);
                if (typeof j.code === "string") (err as { code?: string }).code = j.code;
                reject(err);
              }
            } catch (e) {
              reject(toError(e));
            }
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  const client = {} as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const op of BOUNDED_OPS) client[op] = (...args) => call(op, args);
  return client as unknown as BoundedRuntimeClient;
}

export interface RuntimeHello {
  runtimeProtocolVersion: number;
  draining: boolean;
  ts: number;
}

export function readRuntimeHello(socketPath: string, timeoutMs = 2000): Promise<RuntimeHello> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: "/runtime/hello", method: "GET", timeout: timeoutMs },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(b) as Partial<RuntimeHello>;
            if (typeof j.draining !== "boolean" || typeof j.ts !== "number" || typeof j.runtimeProtocolVersion !== "number") {
              reject(new Error("malformed runtime hello (missing protocol/draining/ts)"));
              return;
            }
            if (j.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION) {
              reject(new Error("runtime protocol mismatch"));
              return;
            }
            resolve(j as RuntimeHello);
          } catch (e) {
            reject(toError(e));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("runtime hello timeout")));
    req.end();
  });
}
