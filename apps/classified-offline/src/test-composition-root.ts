import { HttpCommandServiceClient, LocalEndpointProvider } from "../../../packages/command-service-client/src/index.js";
import { FormatDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import type { LocalDocumentSnapshot, LocalRecognitionTransport } from "../../../packages/recognition-client/src/index.js";
import { LocalWheelRecognitionProvider } from "../../../packages/recognition-client/src/index.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { NoOpTelemetry } from "../../../packages/diagnostics/src/index.js";
import { MockCapabilityProvider, MockDocumentExecutor, MockDocumentReader, MockTransactionManager } from "../../../packages/wps-adapter/src/index.js";

class OfflineLicenseProvider { authorizationScope(): "classified-offline" { return "classified-offline"; } }
/** Unit-test-only composition. Never import this module from Ribbon or taskpane code. */
export function createClassifiedTestComposition(snapshot: LocalDocumentSnapshot, transport: LocalRecognitionTransport, localEndpoint: string, sessionToken: string) {
  return { telemetry: new NoOpTelemetry(), useCase: new FormatDocumentUseCase(
    new MockDocumentReader(snapshot), new LocalWheelRecognitionProvider(transport),
    new HttpCommandServiceClient(new LocalEndpointProvider(localEndpoint, sessionToken)),
    new CommandValidator(), new MockDocumentExecutor(), new MockTransactionManager(), new MockCapabilityProvider(), new OfflineLicenseProvider(),
  ) };
}
