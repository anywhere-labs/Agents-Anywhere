import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

// Offline composition of real product captures; no server or runtime is started.
const root = import.meta.dirname;
const output = resolve(root, "../images");
const preview = resolve(root, "preview");
await mkdir(output, { recursive: true });
await mkdir(preview, { recursive: true });
async function source(name: string) {
  const data = await readFile(resolve(root, "sources", name));
  return `data:image/webp;base64,${data.toString("base64")}`;
}
const font = (await readFile(resolve(root, "sources/caveat.woff2"))).toString(
  "base64",
);
const [mac, phone, tablet, android, windows] = await Promise.all(
  [
    "macbook.webp",
    "iphone.webp",
    "ipad.webp",
    "android.webp",
    "windows.webp",
  ].map(source),
);
const agentMarks = await Promise.all(
  ["codex", "claude", "deepseek"].map(
    async (name) =>
      `data:image/svg+xml;base64,${(await readFile(resolve(root, "sources/agents", `${name}.svg`))).toString("base64")}`,
  ),
);
const css = `
@font-face { font-family:Caveat; src:url(data:font/woff2;base64,${font}); font-weight:400 700; }
* { box-sizing: border-box; }
html, body { margin:0; width:1800px; color:#fff; background:#080808; }
body { font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.canvas { position:relative; overflow:hidden; width:1800px; background:#080808; }
img { display:block; position:absolute; height:auto; }
.wordmark { position:absolute; left:105px; top:65px; font:500 46px/1 Caveat; letter-spacing:0; white-space:nowrap; }
h1 { position:absolute; left:105px; top:212px; margin:0; font-size:88px; font-weight:600; line-height:1.16; letter-spacing:-4px; }
h1 span { color:#a7a7a7; }
.agents { position:absolute; right:105px; top:211px; width:370px; display:flex; flex-direction:column; gap:20px; }
.agent { display:flex; align-items:center; gap:20px; font-size:28px; line-height:40px; color:#e8e8e8; }
.agent img { position:static; width:38px; height:38px; object-fit:contain; }
.coming { margin:4px 0 0; color:#999; font-size:22px; line-height:1.4; }
.mac { width:1340px; left:55px; top:455px; }
.phone { width:285px; right:82px; top:610px; filter:drop-shadow(0 22px 28px #0009); }
.label { position:absolute; color:#b7b7b7; font-size:22px; letter-spacing:2px; }
`;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH || (existsSync(chrome) ? chrome : undefined),
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route("**/*", (route) => route.abort());
  async function render(
    name: string,
    height: number,
    body: string,
    language = "en",
  ) {
    const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${css}</style></head><body><main class="canvas" style="height:${height}px">${body}</main></body></html>`;
    await page.setViewportSize({ width: 1800, height });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    const invalid = await page
      .locator("img")
      .evaluateAll((images) =>
        images.some(
          (image) =>
            !(image instanceof HTMLImageElement) ||
            !image.complete ||
            image.naturalWidth === 0,
        ),
      );
    if (invalid) throw new Error(`Missing source image in ${name}`);
    const screenshot = await page.screenshot();
    await sharp(screenshot)
      .webp({ quality: 90, effort: 6 })
      .toFile(resolve(output, `${name}.webp`));
    await writeFile(resolve(preview, `${name}.html`), html);
    console.log(`${name}.webp: 1800 × ${height}`);
  }
  for (const locale of ["zh", "en"] as const) {
    const title =
      locale === "zh"
        ? "跨设备的<br><span>开源 Agent 工作台。</span>"
        : "An agent workbench.<br><span>Across your devices.</span>";
    await render(
      `readme-hero-${locale}`,
      1300,
      `
      <div class="wordmark">Agents Anywhere</div>
      <h1>${title}</h1>
      <div class="agents">
        <div class="agent"><img src="${agentMarks[0]}" alt="Codex">Codex</div>
        <div class="agent"><img src="${agentMarks[1]}" alt="Claude Code">Claude Code</div>
        <div class="agent"><img src="${agentMarks[2]}" alt="DeepSeek Harness">DeepSeek Harness</div>
        <p class="coming">${locale === "zh" ? "更多 Agent，即将支持" : "More agents coming soon"}</p>
      </div>
      <img class="mac" src="${mac}" alt="Desktop workbench on MacBook">
      <img class="phone" src="${phone}" alt="Conversation on iPhone">
`,
      locale === "zh" ? "zh-CN" : "en",
    );
  }
  await render(
    "readme-mobile",
    1030,
    `
    <div class="label" style="top:54px;left:80px">MOBILE &amp; TABLET CLIENTS</div>
    <img src="${tablet}" alt="iPad workspace with a pending user response" style="width:1120px;left:340px;top:144px">
    <img src="${phone}" alt="iPhone conversation" style="width:295px;left:72px;top:225px;filter:drop-shadow(0 14px 25px #0008)">
    <img src="${android}" alt="Android conversation" style="width:285px;right:62px;top:227px;border-radius:22px;box-shadow:0 0 0 1px #444">
    <div class="label" style="left:181px;bottom:48px">iOS</div>
    <div class="label" style="left:848px;bottom:48px">iPadOS</div>
    <div class="label" style="right:144px;bottom:48px">Android</div>`,
  );
  await render(
    "readme-workbench",
    1160,
    `
    <div class="label" style="top:38px;left:80px">WINDOWS / DESKTOP WORKBENCH</div>
    <img src="${windows}" alt="Windows workbench with projects, sessions and a task result" style="width:1640px;left:80px;top:104px;border-radius:12px;box-shadow:0 0 0 1px #393939,0 24px 70px #0006">`,
  );
} finally {
  await browser.close();
}
