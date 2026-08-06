import { build } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/classified-offline/", import.meta.url));
await build({
  configFile: false,
  root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: resolve(root, "src/host-runtime.ts"),
      name: "DocxtoolHostRuntimeBootstrap",
      formats: ["iife"],
      fileName: () => "host-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

await build({
  configFile: false,
  root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: resolve(root, "src/pipeline-worker.ts"),
      name: "DocxtoolPipelineWorker",
      formats: ["iife"],
      fileName: () => "pipeline-worker.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

await build({
  configFile: false,
  root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: resolve(root, "src/pipeline-worker-probe.ts"),
      name: "DocxtoolPipelineWorkerProbe",
      formats: ["iife"],
      fileName: () => "pipeline-worker-probe.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
