import { ClearFormattingPreviewUseCase, FormatDocumentUseCase, PreviewDocumentUseCase, RecognizeDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import { LocalProcessRecognitionTransport, LocalWheelRecognitionProvider, type WpsApplicationLike } from "../../../packages/recognition-client/src/index.js";
import { LocalFormatCommandGenerator, type LocalFormatProfile } from "../../../packages/local-format-engine/src/index.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { NoOpTelemetry } from "../../../packages/diagnostics/src/index.js";
import type { DiagnosticReporter } from "../../../packages/diagnostics/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsFontCapabilityProvider, WpsPreviewCommentService, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";
import type { PreviewMutationTracker } from "../../../packages/application/src/ports.js";

export interface ClassifiedRuntimeConfig {
  recognitionExecutablePath: string;
  launchProbeExecutablePath?: string;
  runtimeVersion: string;
  runtimeSha256: string;
  recognitionPackageVersion?: string;
  contractVersion?: number;
  runtimeManifestPath?: string;
  diagnosticLogPath?: string;
  threadedPreviewEnabled?: boolean;
}

type ProfileWindow = typeof globalThis & {
  DocxtoolDefaultProfile?: LocalFormatProfile;
  Application?: unknown;
};

export type ClassifiedProductionComposition = ReturnType<typeof createClassifiedProductionComposition>;
let productionComposition: ClassifiedProductionComposition | null = null;
let productionConfigKey = "";

class OfflineLicenseProvider {
  authorizationScope(): "classified-offline" { return "classified-offline"; }
}

function readDefaultProfile(): LocalFormatProfile {
  const profile = (globalThis as ProfileWindow).DocxtoolDefaultProfile;
  if (!profile?.page_setup || !profile.styles) throw new Error("DEFAULT_PROFILE_UNAVAILABLE");
  return profile;
}

/** The only production assembly used by the classified Ribbon. */
export function createClassifiedProductionComposition(config: ClassifiedRuntimeConfig, diagnostics?: DiagnosticReporter) {
  const telemetry = new NoOpTelemetry();
  const reader = new WpsDocumentReader(diagnostics);
  const application = (globalThis as ProfileWindow).Application as WpsApplicationLike | undefined;
  if (!application) throw new Error("WPS_HOST_UNAVAILABLE");
  const recognition = new LocalWheelRecognitionProvider(
    new LocalProcessRecognitionTransport(
      application,
      config.recognitionExecutablePath,
      120_000,
      100,
      20 * 1024 * 1024,
      diagnostics,
    ),
  );
  const commands = new LocalFormatCommandGenerator(readDefaultProfile());
  const validator = new CommandValidator();
  const transaction = new WpsTransactionManager();
  const capability = new WpsCapabilityProvider();
  const executor = new WpsApiDocumentExecutor(undefined, capability, undefined, transaction, { yieldEvery: 15 });
  const fonts = new WpsFontCapabilityProvider();
  const license = new OfflineLicenseProvider();
  let preview: PreviewMutationTracker | null = null;
  const tracker = { current: () => preview, set: (value: PreviewMutationTracker) => { preview = value; }, clear: () => { preview = null; } };
  const previewComments = new WpsPreviewCommentService(diagnostics);
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
export function getClassifiedProductionComposition(config: ClassifiedRuntimeConfig, diagnostics?: DiagnosticReporter): ClassifiedProductionComposition {
  const key = JSON.stringify(config);
  if (!productionComposition) { productionComposition = createClassifiedProductionComposition(config, diagnostics); productionConfigKey = key; }
  else if (productionConfigKey !== key) throw new Error("PRODUCTION_COMPOSITION_CONFIG_MISMATCH");
  return productionComposition;
}
