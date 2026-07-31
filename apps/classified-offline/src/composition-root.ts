import { HttpCommandServiceClient, LocalEndpointProvider } from "../../../packages/command-service-client/src/index.js";
import { ClearFormattingPreviewUseCase, FormatDocumentUseCase, PreviewDocumentUseCase, RecognizeDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import { HttpLocalRecognitionTransport, LocalWheelRecognitionProvider } from "../../../packages/recognition-client/src/index.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { NoOpTelemetry } from "../../../packages/diagnostics/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsFontCapabilityProvider, WpsPreviewCommentService, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";
import type { PreviewMutationTracker } from "../../../packages/application/src/ports.js";

export interface ClassifiedRuntimeConfig {
  recognitionEndpoint: string;
  commandEndpoint: string;
  sessionToken: string;
}
export type ClassifiedProductionComposition = ReturnType<typeof createClassifiedProductionComposition>;
let productionComposition: ClassifiedProductionComposition | null = null;
let productionConfigKey = "";
class OfflineLicenseProvider { authorizationScope(): "classified-offline" { return "classified-offline"; } }

/** The only production assembly used by the classified Ribbon and E2E driver. */
export function createClassifiedProductionComposition(config: ClassifiedRuntimeConfig) {
  const telemetry = new NoOpTelemetry();
  const reader = new WpsDocumentReader();
  const recognition = new LocalWheelRecognitionProvider(new HttpLocalRecognitionTransport(new URL(config.recognitionEndpoint), config.sessionToken));
  const commands = new HttpCommandServiceClient(new LocalEndpointProvider(config.commandEndpoint, config.sessionToken));
  const validator = new CommandValidator();
  const transaction = new WpsTransactionManager();
  const executor = new WpsApiDocumentExecutor(undefined, new WpsCapabilityProvider(), undefined, transaction);
  const capability = new WpsCapabilityProvider();
  const fonts = new WpsFontCapabilityProvider();
  const license = new OfflineLicenseProvider();
  let preview: PreviewMutationTracker | null = null;
  const tracker = { current: () => preview, set: (value: PreviewMutationTracker) => { preview = value; }, clear: () => { preview = null; } };
  const previewComments = new WpsPreviewCommentService();
  return {
    telemetry,
    previewTracker: tracker,
    recognizeUseCase: new RecognizeDocumentUseCase(reader, recognition),
    previewUseCase: new PreviewDocumentUseCase(reader, recognition, commands, validator, capability, license, fonts, previewComments, tracker),
    clearPreviewUseCase: new ClearFormattingPreviewUseCase(previewComments, tracker),
    formatUseCase: new FormatDocumentUseCase(reader, recognition, commands, validator, executor, transaction, capability, license, fonts, previewComments, tracker),
  };
}

/** One production composition per add-in host context. Task panes never call this. */
export function getClassifiedProductionComposition(config: ClassifiedRuntimeConfig): ClassifiedProductionComposition {
  const key = JSON.stringify(config);
  if (!productionComposition) { productionComposition = createClassifiedProductionComposition(config); productionConfigKey = key; }
  else if (productionConfigKey !== key) throw new Error("PRODUCTION_COMPOSITION_CONFIG_MISMATCH");
  return productionComposition;
}
