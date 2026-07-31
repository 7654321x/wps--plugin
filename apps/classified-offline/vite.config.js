import { defineConfig } from "vite";
import { copyFile } from "wpsjs/vite_plugins";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const developmentE2E = process.env.DOCXTOOL_DEVELOPMENT_E2E === "1";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({base:"./",plugins:[
  copyFile({src:"manifest.xml",dest:"manifest.xml"}),copyFile({src:"ribbon.xml",dest:"ribbon.xml"}),
  copyFile({src:developmentE2E ? "main.js" : "main.production.js",dest:"main.js"}),
  copyFile({src:developmentE2E ? "js/ribbon.js" : "js/ribbon-production.js",dest:"js/ribbon.js"}),
  copyFile({src:"ui/taskpane.html",dest:"ui/taskpane.html"}),copyFile({src:"ui/build-info.js",dest:"ui/build-info.js"}),copyFile({src:"ui/default-format-profile.js",dest:"ui/default-format-profile.js"}),
  ...(developmentE2E ? [copyFile({src:"ui/taskpane-development.html",dest:"ui/taskpane-development.html"}),copyFile({src:"ui/e2e-dev.js",dest:"ui/e2e-dev.js"})] : [])
],server:{host:"127.0.0.1"},build:{rollupOptions:{input:{index:resolve(root,"index.html"),"host-runtime":resolve(root,"src/host-runtime.ts"),"taskpane-workflow":resolve(root,"src/taskpane-workflow.ts")},output:{entryFileNames:"[name].js",chunkFileNames:"chunks/[name]-[hash].js"}}}});
