export const WpsUnitConverter = {
  pointTolerance: 0.05,
  fontSizeTolerance: 0.05,
  characterIndentTolerance: 0.01,
  centimetersToPoints(value: number): number { return value * 28.3464567; },
  pointsToCentimeters(value: number): number { return value / 28.3464567; },
  linesToPoints(lines: number, lineSpacingPt: number): number { return lines * lineSpacingPt; },
  close(left: number, right: number): boolean { return Math.abs(left - right) <= this.pointTolerance; },
};

export interface ReadbackFailure { command_id: string; target_id: string; field: string; expected_safe: string | number | boolean; actual_safe: string | number | boolean; tolerance: number; }
export class ReadbackValidator {
  equal(commandId: string, targetId: string, field: string, expected: string | number | boolean, actual: string | number | boolean, tolerance = WpsUnitConverter.pointTolerance): ReadbackFailure | null {
    const match = typeof expected === "number" && typeof actual === "number" ? Math.abs(expected - actual) <= tolerance : expected === actual;
    return match ? null : { command_id: commandId, target_id: targetId, field, expected_safe: expected, actual_safe: actual, tolerance };
  }
}
