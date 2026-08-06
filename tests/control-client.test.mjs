import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_CONTRACT_VERSION,
  LocalHttpControlTransport,
  StaticControlEndpointProvider,
  assertControlJobRequest,
  parseControlEndpointManifest,
} from "../dist/packages/control-client/src/index.js";

const manifest = () => ({
  schema_version: 1,
  instance_id: "11111111-1111-4111-8111-111111111111",
  pid: 1234,
  process_created_at: new Date().toISOString(),
  host: "127.0.0.1",
  port: 43127,
  base_url: "http://127.0.0.1:43127",
  session_token: "t".repeat(48),
  server_version: "1.4.0",
  contract_version: CONTROL_CONTRACT_VERSION,
  started_at: new Date().toISOString(),
  heartbeat_at: new Date().toISOString(),
});
const request = {
  schema_version: 1,
  request_id: "preview-12345678",
  mode: "preview",
  document_token: "doc-token",
  document_revision: "rev-1",
  snapshot_sha256: "a".repeat(64),
  snapshot: { snapshot_contract_version: "worker-snapshot-v1", paragraphs: [] },
};

test("control endpoint manifest rejects fixed port and stale identity", () => {
  assert.equal(parseControlEndpointManifest(manifest()).port, 43127);
  assert.throws(() => parseControlEndpointManifest({ ...manifest(), port: 9528, base_url: "http://127.0.0.1:9528" }), /CONTROL_SERVER_PORT_INVALID/);
  assert.throws(() => parseControlEndpointManifest({ ...manifest(), host: "0.0.0.0" }), /CONTROL_SERVER_VERSION_MISMATCH/);
  assert.throws(() => parseControlEndpointManifest({ ...manifest(), heartbeat_at: new Date(Date.now() - 30_000).toISOString() }), /CONTROL_SERVER_STALE/);
});

test("local HTTP transport owns auth, JSON parsing, and result validation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/health") return new Response(JSON.stringify({ status: "ready", server_version: "1.4.0", contract_version: 1, instance_id: manifest().instance_id, pid: 1234, process_created_at: manifest().process_created_at, heartbeat_at: manifest().heartbeat_at }), { status: 200 });
    if (parsed.pathname === "/v1/jobs" && options.method === "POST") return new Response(JSON.stringify({ job_id: "22222222-2222-4222-8222-222222222222", request_id: request.request_id, status: "queued" }), { status: 202 });
    if (parsed.pathname.endsWith("/result")) return new Response(JSON.stringify({ schema_version: 1, job_id: "22222222-2222-4222-8222-222222222222", request_id: request.request_id, document_token: request.document_token, snapshot_sha256: request.snapshot_sha256, recognition_result: { paragraphs: [] }, formatting_plan: { commands: [] }, warnings: [] }), { status: 200 });
    return new Response(JSON.stringify({ status: "completed", job_id: "22222222-2222-4222-8222-222222222222", request_id: request.request_id, stage: "completed", created_at: new Date().toISOString() }), { status: 200 });
  };
  try {
    const transport = new LocalHttpControlTransport(new StaticControlEndpointProvider(manifest()));
    assertControlJobRequest(request);
    assert.equal((await transport.health()).status, "ready");
    const submitted = await transport.submit(request);
    assert.equal(submitted.status, "queued");
    const result = await transport.result(submitted.job_id, undefined, request);
    assert.deepEqual(result.formatting_plan, { commands: [] });
    assert.equal(calls[1].options.headers.Authorization, "Bearer " + "t".repeat(48));
    assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control request rejects execution fields", () => {
  assert.throws(() => assertControlJobRequest({ ...request, snapshot: { command: "whoami" } }), /CONTROL_SERVER_EXECUTION_FIELD_REJECTED/);
});
