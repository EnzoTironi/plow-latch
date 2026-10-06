import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const result = await build({
  entryPoints: [new URL("web/hub.js", root).pathname], bundle: true, write: false,
  platform: "browser", format: "esm", target: "es2022", minify: false,
});
const source = await readFile(new URL("web/hub.html", root), "utf8");
const marker = '<script id="latch-app" type="module"></script>';
if (source.split(marker).length !== 2) throw new Error("widget_script_marker_invalid");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir(new URL("dist", root), { recursive: true });
await writeFile(new URL("dist/hub.html", root), source.replace(marker, () => `<script type="module">${script}</script>`));
await writeFile(new URL("dist/capabilities.json", root), await readFile(new URL("src/capabilities.json", root), "utf8"));
