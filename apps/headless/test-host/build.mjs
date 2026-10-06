import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
const app = new URL("../", import.meta.url);
await mkdir(new URL("dist/test-host/", app), { recursive: true });
await build({ entryPoints: [new URL("test/fixture.ts", app).pathname], outfile: new URL("dist/test-host/fixture.mjs", app).pathname, bundle: true, platform: "node", format: "esm", packages: "external", define: { "import.meta.url": JSON.stringify(new URL("src/hub.ts", app).href) } });
await build({ entryPoints: [new URL("test-host/host.js", app).pathname], outfile: new URL("dist/test-host/host.js", app).pathname, bundle: true, platform: "browser", format: "esm", target: "es2022" });
