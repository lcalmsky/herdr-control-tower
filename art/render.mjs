// Renders preview.png (1600x960 at 1.5x), demo.gif (168 frames at 20 fps, 1200x720) from art/preview.html,
// and layouts/control-tower.png (640x400), the thumbnail Herdr's layout picker shows, from preview.png.
// Needs playwright-core, Google Chrome and ffmpeg. Run from the repo root:
//   npm i --no-save --prefix /tmp/tower-render playwright-core
//   NODE_PATH=/tmp/tower-render/node_modules node art/render.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { chromium } = createRequire(join(process.env.NODE_PATH ?? ".", "x"))("playwright-core");
const root = resolve(import.meta.dirname, "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const frames = mkdtempSync(join(tmpdir(), "tower-frames-"));

const browser = await chromium.launch({ executablePath: chrome });
async function page(scale) {
  const p = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: scale });
  await p.goto("file://" + join(root, "art/preview.html"), { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  return p;
}

const still = await page(1.5);
await still.evaluate(() => setT(0));
await (await still.$("#win")).screenshot({ path: join(root, "preview.png") });
const thumb = await browser.newPage({ viewport: { width: 640, height: 400 } });
await thumb.setContent(`<style>html,body{margin:0}img{width:640px;height:400px;display:block}</style><img src="data:image/png;base64,${readFileSync(join(root, "preview.png")).toString("base64")}">`, { waitUntil: "load" });
await thumb.screenshot({ path: join(root, "layouts/control-tower.png") });

const anim = await page(0.75);
const win = await anim.$("#win");
for (let i = 0; i < 168; i++) {
  await anim.evaluate((t) => setT(t), i * 50);
  await win.screenshot({ path: join(frames, `f${String(i).padStart(3, "0")}.png`) });
}
await browser.close();

const input = ["-framerate", "20", "-i", join(frames, "f%03d.png")];
execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-vf", "palettegen=stats_mode=diff", join(frames, "pal.png")]);
execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-i", join(frames, "pal.png"),
  "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", join(root, "demo.gif")]);
rmSync(frames, { recursive: true });
console.log("preview.png, demo.gif and layouts/control-tower.png written");
