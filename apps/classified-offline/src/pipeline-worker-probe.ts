type ProbeScope = {
  onmessage: ((event: { data?: { type?: string } }) => void) | null;
  postMessage: (value: { type: string }) => void;
};

const scope = globalThis as unknown as ProbeScope;
scope.onmessage = (event) => {
  if (event.data?.type === "probe.ping") scope.postMessage({ type: "probe.pong" });
};
