export type GridMode = "natural" | "line_only" | "strict_lines_and_chars";
export const DEFAULT_GRID_MODE: GridMode = "line_only";
export const STRICT_GRID_UNSUPPORTED = "DOCUMENT_CHARACTER_GRID_UNSUPPORTED";

export type GridCapabilityName =
  | "PAGE_SIZE" | "PAGE_MARGINS" | "SECTION_ENUMERATION" | "SECTION_ORIENTATION"
  | "LINES_PER_PAGE" | "CHARS_PER_LINE" | "GRID_LAYOUT_MODE" | "GRID_CHAR_SPACE"
  | "GRID_LINE_PITCH" | "PARAGRAPH_SNAP_TO_GRID" | "RUN_CHARACTER_SPACING"
  | "RUN_CHARACTER_SCALING" | "RUN_FIT_TEXT" | "DO_NOT_EXPAND" | "USE_FE_LAYOUT"
  | "BALANCE_SINGLE_DOUBLE_WIDTH";
export type GridCapabilityState = "TYPE_DECLARED" | "RUNTIME_READABLE" | "RUNTIME_WRITABLE" | "READBACK_VERIFIED" | "SAVE_PERSISTED" | "UNSUPPORTED";

export interface GridCapability { name: GridCapabilityName; state: GridCapabilityState; reason?: string; }
export interface PageGeometry { pageWidthPt: number; pageHeightPt: number; topMarginPt: number; bottomMarginPt: number; leftMarginPt: number; rightMarginPt: number; landscape: boolean; }
export interface GridProfile { charsPerLine: number; linesPerPage: number; lineSpacingPt: number; normalFontSizePt: number; }
export interface GridMetrics { contentWidthTwips: number; desiredPitchPt: number; charSpace: number; linePitchTwips: number; }
export interface GridReadback extends PageGeometry { mode: GridMode; layoutMode: number; showGrid: boolean; charsLine?: number; linesPage?: number; snapToGrid: boolean; characterSpacingPt: number; characterScalingPercent: number; fitText: boolean; alignment: "left" | "center" | "right" | "justify" | "distributed"; }

export const TITLE_OUTLINE_LEVELS = new Set([1, 2, 3, 4]);

export function isCharacterGridEnabled(layoutMode: unknown): boolean {
  // wps-jsapi declares wdLayoutModeGrid=1 and wdLayoutModeGenko=3.  We do not
  // use wdLayoutModeLineGrid=2 in line_only: it can still alter WPS layout.
  return Number(layoutMode) === 1 || Number(layoutMode) === 3;
}

/** Matches root core.py: _doc_grid_char_space / _line_spacing_twips. */
export function computeGridMetrics(geometry: PageGeometry, profile: GridProfile): GridMetrics {
  const contentWidthTwips = Math.round((geometry.pageWidthPt - geometry.leftMarginPt - geometry.rightMarginPt) * 20);
  if (contentWidthTwips <= 0 || profile.charsPerLine <= 0 || profile.linesPerPage <= 0 || profile.normalFontSizePt <= 0) throw new Error("INVALID_GRID_METRICS");
  const desiredPitchPt = contentWidthTwips / profile.charsPerLine / 20;
  return {
    contentWidthTwips,
    desiredPitchPt,
    // Root engine rounds toward the narrower grid so the final WPS line does
    // not exceed the usable text area.
    charSpace: Math.floor((desiredPitchPt - profile.normalFontSizePt) * 4096),
    linePitchTwips: Math.round(profile.lineSpacingPt * 20),
  };
}

/** Rotate configured portrait edges clockwise, identical to core.py. */
export function rotateLandscapeMargins(profile: { top: number; bottom: number; left: number; right: number }): { top: number; bottom: number; left: number; right: number } {
  return { top: profile.left, bottom: profile.right, left: profile.bottom, right: profile.top };
}

export function snapToGridForParagraph(mode: GridMode, outlineLevel: number): boolean {
  return mode === "strict_lines_and_chars" && !TITLE_OUTLINE_LEVELS.has(outlineLevel);
}

/**
 * The local wps-jsapi 1.0.5 declaration exposes PageSetup.CharsLine,
 * LinesPage and LayoutMode only.  It has no document-grid charSpace/linePitch
 * or OOXML compatibility-settings API.  Those missing capabilities make a
 * strict 22×28 claim unsafe until a real host proves an equivalent API.
 */
export class DocumentGridCapabilityProvider {
  probe(runtime: { pageSetup?: Record<string, unknown>; paragraphFormat?: Record<string, unknown>; font?: Record<string, unknown>; sections?: unknown } = {}): GridCapability[] {
    const page = runtime.pageSetup;
    const paragraph = runtime.paragraphFormat;
    const font = runtime.font;
    const available = (object: Record<string, unknown> | undefined, key: string) => object !== undefined && key in object;
    const runtimeReadable = (object: Record<string, unknown> | undefined, key: string) => available(object, key) ? "RUNTIME_READABLE" as const : "UNSUPPORTED" as const;
    return [
      ["PAGE_SIZE", runtimeReadable(page, "PageWidth")], ["PAGE_MARGINS", runtimeReadable(page, "LeftMargin")],
      ["SECTION_ENUMERATION", runtime.sections ? "RUNTIME_READABLE" : "UNSUPPORTED"], ["SECTION_ORIENTATION", runtimeReadable(page, "Orientation")],
      ["LINES_PER_PAGE", runtimeReadable(page, "LinesPage")], ["CHARS_PER_LINE", runtimeReadable(page, "CharsLine")], ["GRID_LAYOUT_MODE", runtimeReadable(page, "LayoutMode")],
      ["GRID_CHAR_SPACE", "UNSUPPORTED"], ["GRID_LINE_PITCH", "UNSUPPORTED"],
      ["PARAGRAPH_SNAP_TO_GRID", runtimeReadable(paragraph, "SnapToGrid")], ["RUN_CHARACTER_SPACING", runtimeReadable(font, "Spacing")], ["RUN_CHARACTER_SCALING", runtimeReadable(font, "Scaling")],
      // wps-jsapi declares Range.FitText() but not a read/write run fit-text
      // boolean, so this cannot be verified or persisted as a strict policy.
      ["RUN_FIT_TEXT", "UNSUPPORTED"], ["DO_NOT_EXPAND", "UNSUPPORTED"], ["USE_FE_LAYOUT", "UNSUPPORTED"], ["BALANCE_SINGLE_DOUBLE_WIDTH", "UNSUPPORTED"],
    ].map(([name, state]) => ({ name: name as GridCapabilityName, state: state as GridCapabilityState, ...(state === "UNSUPPORTED" ? { reason: "WPS_JSAPI_1_0_5_MEMBER_UNAVAILABLE" } : {}) }));
  }

  supportsStrict(runtime: { pageSetup?: Record<string, unknown>; paragraphFormat?: Record<string, unknown>; font?: Record<string, unknown>; sections?: unknown } = {}): boolean {
    return this.probe(runtime).every((capability) => capability.state === "SAVE_PERSISTED");
  }
}

export class GridReadbackValidator {
  validateLineOnly(readback: GridReadback): void {
    if (readback.layoutMode !== 0 || readback.showGrid || isCharacterGridEnabled(readback.layoutMode) || readback.snapToGrid || readback.characterSpacingPt !== 0 || readback.characterScalingPercent !== 100 || readback.alignment === "distributed") throw new Error("GRID_READBACK_MISMATCH");
  }

  validateStrict(readback: GridReadback, profile: GridProfile): void {
    if (!isCharacterGridEnabled(readback.layoutMode) || readback.charsLine !== profile.charsPerLine || readback.linesPage !== profile.linesPerPage || readback.characterSpacingPt !== 0 || readback.characterScalingPercent !== 100 || readback.fitText || readback.alignment === "distributed") throw new Error("GRID_READBACK_MISMATCH");
  }

  assertStrictSupported(): never { throw new Error(STRICT_GRID_UNSUPPORTED); }
}

/** Reusable reverse-order journal for page-grid writes and readback failures. */
export class GridTransactionManager {
  private readonly journal: Array<() => void> = [];
  capture(restore: () => void): void { this.journal.push(restore); }
  rollback(): void { for (const restore of this.journal.reverse()) restore(); }
  get size(): number { return this.journal.length; }
}
