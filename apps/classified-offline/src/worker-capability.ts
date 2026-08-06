export interface WorkerCapability {
  supported: boolean;
  classic_worker: boolean;
  roundtrip_ms: number | null;
  error_code: string | null;
}

export async function probeWorkerCapability(workerUrl: string): Promise<WorkerCapability> {
  if (typeof Worker !== "function") return { supported: false, classic_worker: false, roundtrip_ms: null, error_code: "WEB_WORKER_UNSUPPORTED" };
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: WorkerCapability) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      worker?.terminate();
      resolve(value);
    };
    try {
      worker = new Worker(workerUrl);
      worker.onmessage = (event) => {
        if (event.data?.type !== "probe.pong") return;
        finish({ supported: true, classic_worker: true, roundtrip_ms: Math.round(performance.now() - started), error_code: null });
      };
      worker.onerror = () => finish({ supported: false, classic_worker: false, roundtrip_ms: null, error_code: "WEB_WORKER_LOAD_FAILED" });
      worker.postMessage({ type: "probe.ping" });
    } catch {
      finish({ supported: false, classic_worker: false, roundtrip_ms: null, error_code: "WEB_WORKER_CONSTRUCTION_FAILED" });
    }
    timer = setTimeout(() => finish({ supported: false, classic_worker: false, roundtrip_ms: null, error_code: "WEB_WORKER_PROBE_TIMEOUT" }), 3_000);
  });
}
