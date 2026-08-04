/**
 * Local host-text-v1 helpers. These functions never call WPS and are shared
 * by the snapshot reader and the final Range readback path.
 */

export const HOST_TEXT_CONTRACT_VERSION = "host-text-v1" as const;

export interface HostTextTape {
  rawText: string;
  canonicalText: string;
  rawToCanonicalUtf16: ReadonlyMap<number, number>;
  canonicalToRawUtf16: ReadonlyMap<number, number>;
  warnings: readonly string[];
}

/**
 * Portable output used by the shared Python/TypeScript gold fixture.  The
 * arrays deliberately use JavaScript/Python character boundaries as indexes
 * while their values remain UTF-16 offsets, matching the Python SourceTape
 * contract. WPS Range offsets are always derived separately from raw text.
 */
export interface HostTextGoldenResult {
  canonicalText: string;
  rawToCanonicalUtf16: readonly number[];
  canonicalToRawIndex: readonly number[];
  warnings: readonly string[];
}

function utf16Length(value: string): number { return value.length; }

function canonicalPiece(value: string): string {
  if (value === "\r\n" || value === "\r" || value === "\n" || value === "\v") return "\n";
  if (value === "\u00a0" || value === "\u3000") return " ";
  return value.normalize("NFKC");
}

/**
 * Return the exact JSON-safe host-text-v1 shape shared with docxtool's
 * ``canonicalize_host_paragraph_text``. This does not strip WPS terminators:
 * callers must do that only when reading a real WPS paragraph Range.
 */
export function canonicalizeHostParagraphText(rawText: string): HostTextGoldenResult {
  const raw = rawText ?? "";
  const warnings: string[] = raw.endsWith("\x07") ? ["TRAILING_TABLE_CELL_MARKER_PRESENT"] : [];
  const rawBoundaries: number[] = [0];
  const canonicalBoundaries: number[] = [0];
  const pieces: string[] = [];
  let rawIndex = 0;
  let canonicalUtf16 = 0;
  let codeUnitIndex = 0;
  while (codeUnitIndex < raw.length) {
    const start = rawIndex;
    let value = String.fromCodePoint(raw.codePointAt(codeUnitIndex)!);
    codeUnitIndex += value.length;
    rawIndex += 1;
    if (value === "\r" && raw[codeUnitIndex] === "\n") {
      value += "\n";
      codeUnitIndex += 1;
      rawIndex += 1;
    }
    const isTrailingTableMarker = value === "\x07" && codeUnitIndex === raw.length;
    rawBoundaries[start] = canonicalUtf16;
    for (let boundary = start + 1; boundary < rawIndex; boundary += 1) rawBoundaries[boundary] = canonicalUtf16;
    if (!isTrailingTableMarker) {
      for (const character of canonicalPiece(value)) {
        pieces.push(character);
        canonicalUtf16 += utf16Length(character);
        canonicalBoundaries.push(rawIndex);
      }
    }
    rawBoundaries[rawIndex] = canonicalUtf16;
  }
  return {
    canonicalText: pieces.join(""),
    rawToCanonicalUtf16: rawBoundaries,
    canonicalToRawIndex: canonicalBoundaries,
    warnings,
  };
}

/** Remove only editor-generated terminators, never a visible manual break. */
export function stripWpsImplicitParagraphTerminator(value: unknown): string {
  let text = String(value ?? "");
  // Some WPS builds append a paragraph terminator followed by a section/page
  // sentinel.  This pair is not a user-entered form-feed in the paragraph.
  if (text.endsWith("\r\f")) text = text.slice(0, -2);
  if (text.endsWith("\x07")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  return text;
}

export function createHostTextTape(rawText: string): HostTextTape {
  const raw = rawText ?? "";
  const rawToCanonicalUtf16 = new Map<number, number>();
  const canonicalToRawUtf16 = new Map<number, number>();
  const pieces: string[] = [];
  const warnings: string[] = [];
  let rawOffset = 0;
  let canonicalOffset = 0;
  rawToCanonicalUtf16.set(0, 0);
  canonicalToRawUtf16.set(0, 0);
  for (let index = 0; index < raw.length;) {
    const point = raw.codePointAt(index);
    if (point === undefined) break;
    let value = String.fromCodePoint(point);
    index += value.length;
    if (value === "\r" && raw[index] === "\n") { value += "\n"; index += 1; }
    const rawWidth = utf16Length(value);
    rawToCanonicalUtf16.set(rawOffset, canonicalOffset);
    if (rawWidth === 2 && value === "\r\n") rawToCanonicalUtf16.set(rawOffset + 1, canonicalOffset);
    const tableMarker = value === "\x07" && index === raw.length;
    if (tableMarker) {
      warnings.push("TRAILING_TABLE_CELL_MARKER_PRESENT");
    } else {
      for (const character of canonicalPiece(value)) {
        pieces.push(character);
        canonicalOffset += utf16Length(character);
        canonicalToRawUtf16.set(canonicalOffset, rawOffset + rawWidth);
      }
    }
    rawOffset += rawWidth;
    rawToCanonicalUtf16.set(rawOffset, canonicalOffset);
  }
  return { rawText: raw, canonicalText: pieces.join(""), rawToCanonicalUtf16, canonicalToRawUtf16, warnings };
}

export function rawSliceUtf16(rawText: string, start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > rawText.length) return null;
  // Slicing at the middle of a surrogate pair would produce a non-verifiable
  // host range. Reject that boundary rather than guessing a character.
  const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  if (isLowSurrogate(rawText.charCodeAt(start)) || isLowSurrogate(rawText.charCodeAt(end))) return null;
  return rawText.slice(start, end);
}

export function rawRangeForCanonicalRange(tape: HostTextTape, start: number, end: number): [number, number] | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  const rawStart = tape.canonicalToRawUtf16.get(start);
  const rawEnd = tape.canonicalToRawUtf16.get(end);
  return rawStart === undefined || rawEnd === undefined || rawStart >= rawEnd ? null : [rawStart, rawEnd];
}
