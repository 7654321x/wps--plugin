import { CloudEndpointProvider, HttpCommandServiceClient } from "../../../packages/command-service-client/src/index.js";
import { FormatDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import type { LocalRecognitionTransport, LocalDocumentSnapshot } from "../../../packages/recognition-client/src/index.js";
import { LocalWheelRecognitionProvider } from "../../../packages/recognition-client/src/index.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { MockCapabilityProvider, MockDocumentExecutor, MockDocumentReader, MockTransactionManager } from "../../../packages/wps-adapter/src/index.js";
class OnlineLicenseProvider { authorizationScope(): "standard-online" { return "standard-online"; } }
export function createOnlineComposition(snapshot: LocalDocumentSnapshot, transport: LocalRecognitionTransport, fixedHttpsEndpoint: string, accessToken: string) {
  return new FormatDocumentUseCase(
    new MockDocumentReader(snapshot), new LocalWheelRecognitionProvider(transport),
    new HttpCommandServiceClient(new CloudEndpointProvider(fixedHttpsEndpoint, accessToken)),
    new CommandValidator(), new MockDocumentExecutor(), new MockTransactionManager(),
    new MockCapabilityProvider(), new OnlineLicenseProvider(),
  );
}
