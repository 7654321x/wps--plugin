import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const names = [
  "recognition-result.schema.json",
  "command-request.schema.json",
  "formatting-command-set.schema.json",
  "client-capabilities.schema.json",
  "execution-result.schema.json",
];
const schemas = await Promise.all(names.map(async (name) => JSON.parse(
  await readFile(new URL("../schemas/" + name, import.meta.url), "utf8"),
)));
const ajv = new Ajv2020({ strict: false });
schemas.forEach((schema) => ajv.addSchema(schema));
const SHA = "a".repeat(64);
const recognition = {
  schema_version: "1.0", recognition_engine_version: "3.0", document_id: "doc-1",
  document_revision: "rev-1", source_sha256: SHA, document_mode: "normal",
  document_mode_confidence: 1, paragraphs: [{
    target_id: "doc-1:p:0:0", source_paragraph_index: 0, recognized_type: "body",
    section_kind: "body", text_sha256: SHA, text_length: 8, occurrence_index: 0,
    confidence: 1, review_level: "confirmed", needs_review: false,
  }],
};
const capabilities = {
  schema_version: "1.0",
  capabilities: ["paragraph.font", "paragraph.alignment", "paragraph.indent", "paragraph.spacing", "section.page_setup"],
};
const commandSet = {
  schema_version: "1.0", request_id: "request-00000001", service_version: "0.1.0", warnings: [],
  commands: [{
    command_id: "cmd-000001", kind: "paragraph.set_alignment",
    target: { target_id: "doc-1:p:0:0", source_paragraph_index: 0, text_sha256: SHA },
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
    "formatting-command-set.schema.json": commandSet,
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
