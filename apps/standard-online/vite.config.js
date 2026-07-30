import { defineConfig } from "vite";
import { copyFile } from "wpsjs/vite_plugins";
export default defineConfig({base:"./",plugins:[
  copyFile({src:"manifest.xml",dest:"manifest.xml"}),copyFile({src:"ribbon.xml",dest:"ribbon.xml"}),
  copyFile({src:"main.js",dest:"main.js"}),copyFile({src:"js",dest:"js"}),copyFile({src:"ui",dest:"ui"})
],server:{host:"127.0.0.1"}});
