import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const manifestsDir = path.join(root, "manifests");

const targets = [
  { subdir: "chrome", template: "manifest.chrome.json" },
  { subdir: "firefox", template: "manifest.firefox.json" },
];

async function copyDirRecursive(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(from, ent.name);
    const destPath = path.join(to, ent.name);
    if (ent.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });

  for (const { subdir, template } of targets) {
    const out = path.join(distDir, subdir);
    await copyDirRecursive(srcDir, out);
    const manifestPath = path.join(manifestsDir, template);
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const outManifest = path.join(out, "manifest.json");
    await fs.writeFile(outManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  console.log("Built dist/chrome and dist/firefox from src/ + manifests/");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
