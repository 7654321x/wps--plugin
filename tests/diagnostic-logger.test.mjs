import assert from "node:assert/strict";
import test from "node:test";

import { LoopbackDiagnosticLogger } from "../dist/packages/diagnostics/src/index.js";


function config(fetcher, overrides = {}) {
  return {
    endpoint: "http://127.0.0.1:9528",
    sessionToken: "fixture-session-value",
    source: "host",
    component: "host",
    flushIntervalMs: 60_000,
    fetcher,
    ...overrides,
  };
}

test("loopback logger flushes, adopts and redacts without leaking its session token", async () => {
  const calls = [];
  const logger = new LoopbackDiagnosticLogger(config(async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  }));
  logger.info("host.ready", "宿主就绪", { raw_text: "secret paragraph", session_token: "must-not-appear", endpoint_path: "/v1/health" });
  logger.info("endpoint.ready", "端点就绪", { endpoint_origin: "http://127.0.0.1:9528" });
  logger.adopt([{ timestamp: new Date().toISOString(), level: "WARN", component: "ribbon", event: "early.event", message: "早期事件", data: { password: "must-not-appear" } }]);
  await logger.flush();

  assert.equal(logger.pendingCount(), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9528/v1/diagnostics/logs");
  const body = String(calls[0].init.body);
  const payload = JSON.parse(body);
  assert.equal(payload.events.length, 3);
  assert.equal(payload.events[0].data.raw_text, "[redacted]");
  assert.equal(payload.events[0].data.endpoint_path, "/v1/health");
  assert.equal(payload.events[1].data.endpoint_origin, "http://127.0.0.1:9528");
  assert.equal(body.includes("must-not-appear"), false);
  assert.equal(body.includes("fixture-session-value"), false);
  logger.dispose();
});

test("loopback logger requeues a failed batch and never throws into business code", async () => {
  let fail = true;
  const logger = new LoopbackDiagnosticLogger(config(async () => {
    if (fail) throw new Error("offline");
    return { ok: true, status: 200 };
  }));
  assert.doesNotThrow(() => logger.warn("request.start", "请求开始"));
  await assert.doesNotReject(() => logger.flush());
  assert.equal(logger.pendingCount(), 1);
  fail = false;
  await logger.flush();
  assert.equal(logger.pendingCount(), 0);
  logger.dispose();
});

test("loopback logger caps its queue at 500 and sends no more than 50 per batch", async () => {
  const batches = [];
  const logger = new LoopbackDiagnosticLogger(config(async (_url, init) => {
    batches.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200 };
  }));
  for (let index = 0; index < 550; index += 1) logger.debug(`queued.${index}`, "queued");
  assert.equal(logger.pendingCount(), 500);
  await logger.flush();
  assert.equal(batches[0].events.length, 50);
  assert.equal(logger.pendingCount(), 450);
  logger.dispose();
});

test("ERROR triggers an immediate flush", async () => {
  let calls = 0;
  const logger = new LoopbackDiagnosticLogger(config(async () => {
    calls += 1;
    return { ok: true, status: 200 };
  }));
  logger.error("preview.failed", "预览失败", {}, new Error("fixture failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(logger.pendingCount(), 0);
  logger.dispose();
});

test("dispose clears the interval and fixed endpoint validation rejects other ports", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let cleared = false;
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.clearInterval = () => { cleared = true; };
  try {
    const logger = new LoopbackDiagnosticLogger(config(async () => ({ ok: true, status: 200 })));
    logger.dispose();
    assert.equal(cleared, true);
    assert.throws(() => new LoopbackDiagnosticLogger(config(async () => ({ ok: true, status: 200 }), { endpoint: "http://127.0.0.1:9529" })), /DIAGNOSTIC_ENDPOINT_MUST_BE/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
