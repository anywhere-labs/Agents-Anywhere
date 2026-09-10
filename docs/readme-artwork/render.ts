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
const css = `
@font-face { font-family:Caveat; src:url(data:font/woff2;base64,${font}); font-weight:400 700; }
* { box-sizing: border-box; }
html, body { margin:0; width:1800px; color:#fff; background:#080808; }
body { font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.canvas { position:relative; overflow:hidden; width:1800px; background:radial-gradient(ellipse at 55% 80%, #232323 0%, #101010 43%, #080808 76%); }
img { display:block; position:absolute; height:auto; }
.wordmark { position:absolute; left:105px; top:65px; font:500 65px/1 Caveat; letter-spacing:0; white-space:nowrap; }
.eyebrow { position:absolute; top:98px; right:98px; color:#a7a7a7; font-size:20px; letter-spacing:3px; }
h1 { position:absolute; left:105px; top:212px; margin:0; font-size:88px; font-weight:600; line-height:1.16; letter-spacing:-4px; }
h1 span { color:#a7a7a7; }
.agents { position:absolute; right:105px; top:288px; border-left:1px solid #444; padding-left:30px; font-size:23px; line-height:1.9; color:#d0d0d0; }
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
        ? "Agent 在工作。<br><span>你，尽管自由。</span>"
        : "Agents at work.<br><span>You, anywhere.</span>";
    await render(
      `readme-hero-${locale}`,
      1300,
      `
      <div class="wordmark">Agents Anywhere</div>
      <div class="eyebrow">DESKTOP / MOBILE / WEB</div>
      <h1>${title}</h1>
      <div class="agents">Codex<br>Claude Code<br>DeepSeek Harness</div>
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
    <div class="label" style="top:54px;left:80px">ONE WORKSPACE. EVERY SCREEN.</div>
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
