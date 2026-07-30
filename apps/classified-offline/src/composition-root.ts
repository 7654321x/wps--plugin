import { HttpCommandServiceClient, LocalEndpointProvider } from "../../../packages/command-service-client/src/index.js";
import { FormatDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import type { LocalRecognitionTransport, LocalDocumentSnapshot } from "../../../packages/recognition-client/src/index.js";
import { LocalWheelRecognitionProvider } from "../../../packages/recognition-client/src/index.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { NoOpTelemetry } from "../../../packages/diagnostics/src/index.js";
import { MockCapabilityProvider, MockDocumentExecutor, MockDocumentReader, MockTransactionManager, WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";
class OfflineLicenseProvider { authorizationScope(): "classified-offline" { return "classified-offline"; } }
export function createClassifiedComposition(snapshot: LocalDocumentSnapshot, transport: LocalRecognitionTransport, localEndpoint: string, sessionToken: string) {
  const telemetry = new NoOpTelemetry();
  return { telemetry, useCase: new FormatDocumentUseCase(
    new MockDocumentReader(snapshot), new LocalWheelRecognitionProvider(transport),
    new HttpCommandServiceClient(new LocalEndpointProvider(localEndpoint, sessionToken)),
    new CommandValidator(), new MockDocumentExecutor(), new MockTransactionManager(),
    new MockCapabilityProvider(), new OfflineLicenseProvider(),
  ) };
}

/** The Ribbon/E2E entry point must use this composition, never taskpane writes. */
export function createClassifiedWpsComposition(transport: LocalRecognitionTransport, localEndpoint: string, sessionToken: string) {
  const telemetry = new NoOpTelemetry();
  return { telemetry, useCase: new FormatDocumentUseCase(
    new WpsDocumentReader(), new LocalWheelRecognitionProvider(transport),
    new HttpCommandServiceClient(new LocalEndpointProvider(localEndpoint, sessionToken)),
    new CommandValidator(), new WpsApiDocumentExecutor(), new WpsTransactionManager(),
    new WpsCapabilityProvider(), new OfflineLicenseProvider(),
  ) };
}
