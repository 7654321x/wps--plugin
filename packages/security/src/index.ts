import { assertCommandRequest, assertFormattingCommandSet, type CommandRequest, type FormattingCommandSet } from "../../contracts/src/index.js";
export class CommandValidator {
  validate(value: FormattingCommandSet, requestId: string): FormattingCommandSet { assertFormattingCommandSet(value, requestId); return value; }
}
export function validateOutboundRequest(request: CommandRequest): void { assertCommandRequest(request); }
