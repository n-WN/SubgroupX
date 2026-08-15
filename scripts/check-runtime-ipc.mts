import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import { runtimeClient } from "../server/src/runtime/manager.ts";
import { createRuntimeHost, makeRuntimeHttpClient, RUNTIME_PROTOCOL_VERSION } from "../server/src/runtime/runtime-ipc.ts";
import { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } from "../server/src/runtime/providers.ts";
import { signup } from "../server/src/identity/auth.ts";

process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
registerMockProvider();

const sock = path.join(os.tmpdir(), `oiia-rt-ipc-${process.pid}.sock`);
const host = createRuntimeHost(runtimeClient, sock);
await new Promise<void>((r) => host.once("listening", () => r()));

try {
  const ipc = makeRuntimeHttpClient(sock);
  const uid = `u_ipc_check_${process.pid}`;

  assert.equal(await ipc.isDraining(), runtimeClient.isDraining(), "isDraining mismatch");
  assert.deepEqual(
    await ipc.getExecutorAvailability(),
    runtimeClient.getExecutorAvailability(),
    "executor availability mismatch",
  );
  assert.deepEqual(await ipc.listSessions(uid), runtimeClient.listSessions(uid), "listSessions mismatch");
  assert.equal(await ipc.getSessionInfo(uid, "s_none"), runtimeClient.getSessionInfo(uid, "s_none"), "getSessionInfo mismatch");
  assert.deepEqual(await ipc.liveSessionStatuses(uid), runtimeClient.liveSessionStatuses(uid), "liveSessionStatuses mismatch");
  assert.equal(await ipc.releaseIfIdle(uid, "s_none"), null, "releaseIfIdle should round-trip as null");

  const cuid = (await signup(`ipc-conn-${process.pid}@gmail.com`, "password123")).id;
  try {
    const created = await ipc.connectorCreateToken(cuid, "ipc-test", "~/.agent-web/workspaces");
    assert.ok(created.token && created.info?.id, "connectorCreateToken returns token+info over IPC");
    assert.deepEqual(await ipc.connectorList(cuid), runtimeClient.connectorList(cuid), "connectorList parity (IPC vs in-process)");
    assert.ok((await ipc.connectorList(cuid)).some((c) => c.id === created.info.id), "created connector is listed");

    const pairing = await ipc.connectorCreatePairing(cuid, "ipc-pair", "~/.agent-web/workspaces");
    assert.ok(pairing.code && pairing.pairing?.id, "connectorCreatePairing returns code+pairing over IPC");
    const redeemed = await ipc.connectorRedeemPairing(pairing.code, { name: "redeemed" });
    assert.ok(redeemed.token && redeemed.info?.id, "connectorRedeemPairing returns token+info over IPC");

    await assert.rejects(ipc.connectorTestExec(created.info.id, { sessionId: "hc", command: "true", timeoutMs: 5_000 }), /offline/i, "connectorTestExec rejects offline over IPC");
    await assert.rejects((async () => runtimeClient.connectorTestExec(created.info.id, { sessionId: "hc", command: "true", timeoutMs: 5_000 }))(), /offline/i, "connectorTestExec rejects offline in-process");
    await assert.rejects(ipc.connectorTelemetry(created.info.id), /offline/i, "connectorTelemetry rejects offline over IPC");
    await assert.rejects((async () => runtimeClient.connectorTelemetry(created.info.id))(), /offline/i, "connectorTelemetry rejects offline in-process");

    await ipc.connectorDelete(cuid, created.info.id);
    assert.ok(!(await ipc.connectorList(cuid)).some((c) => c.id === created.info.id), "connector removed after delete over IPC");
  } finally {
    for (const c of runtimeClient.connectorList(cuid)) runtimeClient.connectorDelete(cuid, c.id);
  }

  assert.equal(await ipc.getSessionTimeline(uid, "s_none"), runtimeClient.getSessionTimeline(uid, "s_none"), "getSessionTimeline parity (unknown session → null)");
  assert.equal(await ipc.getSessionTimeline(uid, "s_none"), null, "getSessionTimeline unknown session → null over IPC");
  assert.deepEqual(await ipc.tryStartTurn(uid, "s_none", "hello"), { error: "not-found" }, "tryStartTurn unknown session → not-found over IPC");
  assert.deepEqual(await ipc.writeUpload(uid, "s_none", "a.txt", Buffer.from("hi").toString("base64")), { ok: false, error: "not-found" }, "writeUpload unknown session → not-found over IPC");

  const lu = await signup(`ipc-3g-${process.pid}@gmail.com`, "password123");
  const lsid = runtimeClient.createSession(lu, { provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request" }).id;
  try {
    runtimeClient.getRuntime(lu.id, lsid);
    const tIpc = await ipc.getSessionTimeline(lu.id, lsid);
    const tLocal = runtimeClient.getSessionTimeline(lu.id, lsid);
    assert.deepEqual(tIpc, tLocal, "getSessionTimeline parity on a LIVE session (IPC ≡ in-process)");
    assert.ok(tIpc && typeof tIpc.epoch === "string" && Array.isArray(tIpc.items) && typeof tIpc.status === "string", "getSessionTimeline returns a real {epoch,items,status} over IPC");

    const up = await ipc.writeUpload(lu.id, lsid, "hello.txt", Buffer.from("hello").toString("base64"));
    assert.deepEqual(up, { ok: true, path: "uploads/hello.txt" }, "writeUpload base64 round-trips end-to-end over IPC → {ok,path}");
  } finally {
    runtimeClient.disposeUserRuntimes(lu.id);
  }

  const su = await signup(`ipc-skill-${process.pid}@gmail.com`, "password123");
  await assert.rejects(
    ipc.createSession(su, {
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL_ID,
      mode: "sk_missing",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    }),
    (e: unknown) => (e as { code?: unknown })?.code === "invalid_skill",
    "InvalidSkillError code must survive the socket so the route maps it to unknown skill",
  );

  await assert.rejects(
    rawRpc(sock, "getRuntime", [uid, "s_none"]),
    /op not allowed/,
    "host must reject non-bounded ops",
  );

  const hello = await rawGet(sock, "/runtime/hello");
  assert.equal(hello.runtimeProtocolVersion, RUNTIME_PROTOCOL_VERSION, "hello version mismatch");
  assert.equal(typeof hello.draining, "boolean", "hello.draining missing");
  assert.equal(typeof hello.ts, "number", "hello.ts missing");

  await checkNonStringCodeSurvives();

  console.log("OK runtime-ipc: bounded ops round-trip + error code + non-string code drop + whitelist + hello over unix socket");
} finally {
  host.close();
  try {
    fs.unlinkSync(sock);
  } catch {
  }
}
process.exit(0);

function rawRpc(socketPath: string, method: string, args: unknown[]): Promise<unknown> {
  const payload = JSON.stringify({ method, args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: "/rpc", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          const j = JSON.parse(b) as { ok: boolean; result?: unknown; error?: string };
          j.ok ? resolve(j.result) : reject(new Error(j.error));
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function rawGet(socketPath: string, p: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: p, method: "GET" }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
    req.end();
  });
}

// A bounded op whose error `code` is non-JSON-serializable (bigint) must not crash
// the host: the code is dropped, the message still round-trips, and the host lives on.
async function checkNonStringCodeSurvives(): Promise<void> {
  const stub = {
    getSessionInfo() {
      throw Object.assign(new Error("boom"), { code: 1n });
    },
    listSessions: () => [],
  } as unknown as typeof runtimeClient;
  const badSock = path.join(os.tmpdir(), `oiia-rt-ipc-badcode-${process.pid}.sock`);
  const badHost = createRuntimeHost(stub, badSock);
  await new Promise<void>((r) => badHost.once("listening", () => r()));
  try {
    const ipc = makeRuntimeHttpClient(badSock);
    // bound each call so a hanging host fails the check instead of blocking CI forever
    const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout: ${label} did not settle`)), 5000).unref(),
        ),
      ]);
    await assert.rejects(
      withTimeout(ipc.getSessionInfo("u", "s"), "getSessionInfo"),
      (e: unknown) =>
        e instanceof Error && e.message === "boom" && (e as { code?: unknown }).code === undefined,
      "non-string code must reject with the message and drop code, not crash on JSON.stringify",
    );
    assert.deepEqual(
      await withTimeout(ipc.listSessions("u"), "listSessions"),
      [],
      "host survives a non-serializable code: a subsequent bounded call still succeeds",
    );
  } finally {
    badHost.close();
    try {
      fs.unlinkSync(badSock);
    } catch {
    }
  }
}
