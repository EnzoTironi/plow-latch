import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const result = await build({
  entryPoints: [new URL("web/hub.js", root).pathname], bundle: true, write: false,
  platform: "browser", format: "esm", target: "es2022", minify: false,
});
const source = await readFile(new URL("web/hub.html", root), "utf8");
const styles = await readFile(new URL("web/hub.css", root), "utf8");
const fontRoot = new URL("../desktop/src/renderer/fonts/", root);
const fonts = await Promise.all([
  ["DM Sans", "dm-sans-latin.woff2", "300 700"],
  ["Epilogue", "epilogue-latin.woff2", "400 800"],
  ["DM Mono", "dm-mono-400-latin.woff2", "400"],
].map(async ([family, file, weight]) => `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${(await readFile(new URL(file, fontRoot))).toString("base64")}) format("woff2")}`));
const styleMarker = '<style id="latch-styles"></style>';
if (source.split(styleMarker).length !== 2) throw new Error("widget_style_marker_invalid");
const marker = '<script id="latch-app" type="module"></script>';
if (source.split(marker).length !== 2) throw new Error("widget_script_marker_invalid");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir(new URL("dist", root), { recursive: true });
await writeFile(new URL("dist/hub.html", root), source.replace(styleMarker, () => `<style>${fonts.join("\n")}\n${styles}</style>`).replace(marker, () => `<script type="module">${script}</script>`));
await writeFile(new URL("dist/LICENSE-fonts.txt", root), await readFile(new URL("OFL.txt", fontRoot)));
await writeFile(new URL("dist/capabilities.json", root), await readFile(new URL("src/capabilities.json", root), "utf8"));
