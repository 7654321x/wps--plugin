import { defineConfig } from "vite";
import { copyFile } from "wpsjs/vite_plugins";
const developmentE2E = process.env.DOCXTOOL_DEVELOPMENT_E2E === "1";
export default defineConfig({base:"./",plugins:[
  copyFile({src:"manifest.xml",dest:"manifest.xml"}),copyFile({src:"ribbon.xml",dest:"ribbon.xml"}),
  copyFile({src:developmentE2E ? "main.js" : "main.production.js",dest:"main.js"}),
  copyFile({src:developmentE2E ? "js/ribbon.js" : "js/ribbon-production.js",dest:"js/ribbon.js"}),
  copyFile({src:"ui/taskpane.html",dest:"ui/taskpane.html"}),
  ...(developmentE2E ? [copyFile({src:"ui/taskpane-development.html",dest:"ui/taskpane-development.html"}),copyFile({src:"ui/e2e-dev.js",dest:"ui/e2e-dev.js"})] : [])
],server:{host:"127.0.0.1"}});
