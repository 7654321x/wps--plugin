import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const names = [
  "recognition-result.schema.json",
  "command-request.schema.json",
  "formatting-command-set.schema.json",
  "formatting-command-set-1.2.schema.json",
  "client-capabilities.schema.json",
  "execution-result.schema.json",
  "control-job-request.schema.json",
  "control-job-result.schema.json",
  "control-endpoint-manifest.schema.json",
];
const schemas = await Promise.all(names.map(async (name) => JSON.parse(
  await readFile(new URL("../schemas/" + name, import.meta.url), "utf8"),
)));
const ajv = new Ajv2020({ strict: false });
schemas.forEach((schema) => ajv.addSchema(schema));
const SHA = "a".repeat(64);
const recognition = {
  schema_version: "1.2", recognition_engine_version: "3.0", document_id: "doc-1",
  document_revision: "rev-1", source_sha256: SHA, document_mode: "normal",
  document_mode_confidence: 1, paragraphs: [{
    target_id: "doc-1:p:0:0", source_paragraph_index: 0, host_paragraph_index: 0,
    host_raw_start_utf16: 0, host_raw_end_utf16: 8, host_raw_text_sha256: SHA, recognized_type: "body",
    section_kind: "body", text_sha256: SHA, text_length: 8, occurrence_index: 0,
    confidence: 1, review_level: "confirmed", needs_review: false,
    physical_paragraph_index: 0, physical_text_sha256: SHA,
    range_start_utf16: 0, range_end_utf16: 8, locator_verified: true,
    mixed_structure: false, formatting_disposition: "apply",
    host_text_contract_version: "host-text-v1", host_canonical_start_utf16: 0,
    host_canonical_end_utf16: 8, binding_status: "confirmed", binding_confidence: 1,
    segment_count_total: 1, segment_count_located: 1, segment_count_confirmed: 1,
  }],
};
const capabilities = {
  schema_version: "1.0",
  capabilities: ["paragraph.font", "paragraph.alignment", "paragraph.indent", "paragraph.spacing", "section.page_setup"],
};
const commandSet = {
  schema_version: "1.2", request_id: "request-00000001", service_version: "1.0", profile_id: "default", profile_version: "1.0", warnings: [],
  commands: [{
    command_id: "cmd-000001", kind: "paragraph.set_alignment",
    target: { target_id: "doc-1:p:0:0", source_paragraph_index: 0, host_paragraph_index: 0, host_raw_start_utf16: 0, host_raw_end_utf16: 8, host_raw_text_sha256: SHA, text_sha256: SHA, text_length: 8, occurrence_index: 0 },
    arguments: { alignment: "justify" }, required_capability: "paragraph.alignment", on_unsupported: "skip",
  }],
};

test("all frozen protocol fixtures validate against their JSON Schemas", () => {
  const fixtures = {
    "recognition-result.schema.json": recognition,
    "client-capabilities.schema.json": capabilities,
    "command-request.schema.json": {
      schema_version: "1.0", request_id: "request-00000001", recognition_result: recognition,
      profile_id: "default", profile_version: "1.0", client_capabilities: capabilities,
      product_version: "0.1.0", authorization_scope: "classified-offline",
    },
    "formatting-command-set-1.2.schema.json": commandSet,
    "execution-result.schema.json": {
      schema_version: "1.0", transaction_id: "mock-tx-1", executed_command_ids: ["cmd-000001"],
      skipped_command_ids: [], failed_command_id: null, warnings: [], rolled_back: false, document_revision: "rev-1",
    },
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    const valid = ajv.getSchema(schemas[names.indexOf(name)].$id)(fixture);
    assert.equal(valid, true, name + ": " + ajv.errorsText());
  }
});

test("command request schema rejects plaintext and absolute-path fields", () => {
  const validate = ajv.getSchema(schemas[names.indexOf("command-request.schema.json")].$id);
  const unsafe = {
    schema_version: "1.0", request_id: "request-00000001", recognition_result: recognition,
    profile_id: "default", profile_version: "1.0", client_capabilities: capabilities,
    product_version: "0.1.0", authorization_scope: "classified-offline", local_path: "C:/secret.docx",
  };
  assert.equal(validate(unsafe), false);
});

test("control-plane schemas keep the endpoint and job envelope bounded", () => {
  const requestSchema = ajv.getSchema("https://docxtool.local/schemas/control-job-request.schema.json");
  const resultSchema = ajv.getSchema("https://docxtool.local/schemas/control-job-result.schema.json");
  const endpointSchema = ajv.getSchema("https://docxtool.local/schemas/control-endpoint-manifest.schema.json");
  const request = { schema_version: 1, request_id: "preview-12345678", mode: "preview", document_token: "doc-1", document_revision: "rev-1", snapshot_sha256: "a".repeat(64), snapshot: { paragraphs: [] } };
  assert.equal(requestSchema(request), true);
  assert.equal(requestSchema({ ...request, executable: "bad.exe" }), false);
  assert.equal(resultSchema({ schema_version: 1, job_id: "22222222-2222-4222-8222-222222222222", request_id: request.request_id, document_token: request.document_token, snapshot_sha256: request.snapshot_sha256, recognition_result: {}, formatting_plan: { commands: [] }, warnings: [] }), true);
  assert.equal(endpointSchema({ schema_version: 1, instance_id: "11111111-1111-4111-8111-111111111111", pid: 1, process_created_at: "now", host: "127.0.0.1", port: 43127, base_url: "http://127.0.0.1:43127", session_token: "t".repeat(32), server_version: "1.4.0", contract_version: 1, started_at: "now", heartbeat_at: "now" }), true);
  assert.equal(endpointSchema({ schema_version: 1, instance_id: "11111111-1111-4111-8111-111111111111", pid: 1, process_created_at: "now", host: "127.0.0.1", port: 9528, base_url: "http://127.0.0.1:9528", session_token: "t".repeat(32), server_version: "1.4.0", contract_version: 1, started_at: "now", heartbeat_at: "now" }), false);
});
