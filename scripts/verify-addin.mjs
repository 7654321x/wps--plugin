import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const editions = ["classified-offline", "standard-online"];
const selected = process.argv.slice(2);
const requested = selected.length ? selected : editions;
if (requested.some((edition) => !editions.includes(edition))) {
  console.error("ADDIN_VERIFY_INVALID_EDITION");
  process.exit(2);
}

async function mustRead(file, code) {
  try { return await readFile(file, "utf8"); } catch { throw new Error(code); }
}
async function verify(edition) {
  const root = resolve("apps", edition);
  const manifest = await mustRead(resolve(root, "manifest.xml"), "MANIFEST_MISSING");
  const ribbon = await mustRead(resolve(root, "ribbon.xml"), "RIBBON_XML_MISSING");
  const packageJson = JSON.parse(await mustRead(resolve(root, "package.json"), "ADDIN_PACKAGE_MISSING"));
  for (const file of ["index.html", "main.js", "js/ribbon.js", "ui/taskpane.html"]) {
    try { await access(resolve(root, file)); } catch { throw new Error("ADDIN_ENTRY_MISSING"); }
  }
  if (!/^docxtool-(classified-offline|standard-online)$/.test(packageJson.name)) throw new Error("ADDIN_ID_INVALID");
  if (!manifest.includes("<JsPlugin>") || !manifest.includes("<ApiVersion>")) throw new Error("MANIFEST_INVALID");
  if (!ribbon.includes("http://schemas.microsoft.com/office/2006/01/customui") || !ribbon.includes('onLoad="OnAddinLoad"') || !ribbon.includes('onAction="OnAction"')) throw new Error("RIBBON_XML_INVALID");
  if (edition === "classified-offline") {
    const buttons = [...ribbon.matchAll(/<button\s+id="([^"]+)"\s+label="([^"]+)"\s+onAction="([^"]+)"/g)].map((match) => match.slice(1));
    if (JSON.stringify(buttons) !== JSON.stringify([["preview", "预览排版", "OnAction"], ["apply", "一键排版", "OnAction"], ["health", "功能检测", "OnAction"]])) throw new Error("CLASSIFIED_RIBBON_ACTIONS_INVALID");
    if (/https:\/\//.test(await mustRead(resolve(root, "src/composition-root.ts"), "COMPOSITION_ROOT_MISSING"))) throw new Error("CLASSIFIED_PUBLIC_URL_FORBIDDEN");
  } else if (!ribbon.includes('id="taskpane"') || !ribbon.includes('label="打开任务窗格"')) throw new Error("TASKPANE_RIBBON_MISSING");
  console.log(`ADDIN_VERIFY_PASS ${packageJson.name}`);
}

try { for (const edition of requested) await verify(edition); }
catch (error) { console.error(error instanceof Error ? error.message : "ADDIN_VERIFY_FAILED"); process.exit(1); }
