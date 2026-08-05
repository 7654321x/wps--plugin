import { defineConfig } from "vite";
import { copyFile } from "wpsjs/vite_plugins";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({base:"./",plugins:[
  copyFile({src:"manifest.xml",dest:"manifest.xml"}),copyFile({src:"ribbon.xml",dest:"ribbon.xml"}),
  copyFile({src:"main.js",dest:"main.js"}),copyFile({src:"js/ribbon.js",dest:"js/ribbon.js"}),copyFile({src:"js/bootstrap-probe.js",dest:"js/bootstrap-probe.js"}),
  copyFile({src:"ui/taskpane.html",dest:"ui/taskpane.html"}),copyFile({src:"ui/build-info.js",dest:"ui/build-info.js"}),copyFile({src:"ui/default-format-profile.js",dest:"ui/default-format-profile.js"}),copyFile({src:"ui/local-runtime-config.js",dest:"ui/local-runtime-config.js"})
],server:{host:"127.0.0.1"},build:{rollupOptions:{input:{index:resolve(root,"index.html"),"taskpane-workflow":resolve(root,"src/taskpane-workflow.ts")},output:{entryFileNames:"[name].js",chunkFileNames:"chunks/[name]-[hash].js"}}}});
