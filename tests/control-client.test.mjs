import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_CONTRACT_VERSION,
  CONTROL_SERVER_VERSION,
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
  server_version: CONTROL_SERVER_VERSION,
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
    if (parsed.pathname === "/v1/health") return new Response(JSON.stringify({ status: "ready", server_version: CONTROL_SERVER_VERSION, contract_version: 1, instance_id: manifest().instance_id, pid: 1234, process_created_at: manifest().process_created_at, heartbeat_at: manifest().heartbeat_at }), { status: 200 });
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

test("local HTTP transport owns the one-time document repair lifecycle", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const repairId = "33333333-3333-4333-8333-333333333333";
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ pathname, body: JSON.parse(String(options.body)) });
    if (pathname.endsWith("/inspect")) return new Response(JSON.stringify({ schema_version: 1, status: "repair_required", repair_id: repairId, broken_relationship_count: 1, package_member_count: 5, document_relationship_count: 2, null_relationship_count: 1, dangling_drawing_count: 0 }), { status: 200 });
    if (pathname.endsWith("/apply")) return new Response(JSON.stringify({ schema_version: 1, status: "applied", repair_id: repairId, removed_relationship_count: 1, removed_drawing_count: 1 }), { status: 200 });
    return new Response(JSON.stringify({ schema_version: 1, status: "committed", repair_id: repairId }), { status: 200 });
  };
  try {
    const transport = new LocalHttpControlTransport(new StaticControlEndpointProvider(manifest()));
    assert.equal((await transport.inspectDocumentRepair("C:\\fixture.docx", "doc-1")).status, "repair_required");
    assert.equal((await transport.applyDocumentRepair(repairId)).status, "applied");
    assert.equal((await transport.completeDocumentRepair(repairId, "commit")).status, "committed");
    assert.deepEqual(calls.map((item) => item.pathname), ["/v1/document-repairs/inspect", `/v1/document-repairs/${repairId}/apply`, `/v1/document-repairs/${repairId}/complete`]);
    assert.deepEqual(calls[2].body, { schema_version: 1, outcome: "commit" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local HTTP transport preserves structured server failure details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "DOCUMENT_REPAIR_FAILED", details: { stage: "inspect.relationships", reason: "relationship_target_missing", exception_type: "KeyError", member: "word/_rels/document.xml.rels" } } }), { status: 409 });
  try {
    const transport = new LocalHttpControlTransport(new StaticControlEndpointProvider(manifest()));
    await assert.rejects(
      transport.inspectDocumentRepair("C:\\fixture.docx", "doc-1"),
      (error) => error.code === "DOCUMENT_REPAIR_FAILED" && error.status === 409 && error.details.stage === "inspect.relationships" && error.details.reason === "relationship_target_missing",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
