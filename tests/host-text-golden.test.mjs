import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalizeHostParagraphText,
  createHostTextTape,
  rawRangeForCanonicalRange,
  rawSliceUtf16,
} from "../dist/packages/wps-adapter/src/host-text.js";

const golden = JSON.parse(await readFile(new URL("../docs/HOST_TEXT_V1_GOLDEN.json", import.meta.url), "utf8"));

test("host-text-v1 TypeScript implementation matches the synchronized Python gold fixture", () => {
  assert.equal(golden.text_contract_version, "host-text-v1");
  for (const item of golden.canonical_cases) {
    const actual = canonicalizeHostParagraphText(item.raw_text);
    assert.equal(actual.canonicalText, item.canonical_text, item.id);
    assert.deepEqual(actual.rawToCanonicalUtf16, item.raw_to_canonical_utf16, item.id);
    assert.deepEqual(actual.canonicalToRawIndex, item.canonical_to_raw_index, item.id);
    assert.deepEqual(actual.warnings, item.warnings, item.id);
  }
});

test("host-text-v1 rejects UTF-16 ranges that split a surrogate pair", () => {
  assert.equal(rawSliceUtf16("甲😀乙", 1, 2), null);
  assert.equal(rawSliceUtf16("甲😀乙", 1, 3), "😀");
});

test("host-text-v1 canonical range mapping only returns verified raw boundaries", () => {
  const tape = createHostTextTape("甲\r\nＢ");
  assert.equal(tape.canonicalText, "甲\nB");
  assert.deepEqual(rawRangeForCanonicalRange(tape, 1, 3), [1, 4]);
  assert.equal(rawRangeForCanonicalRange(tape, 2, 2), null);
});
