import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const manifestsDir = path.join(root, "manifests");
const pkgPath = path.join(root, "package.json");

const targets = [
  { subdir: "chrome", template: "manifest.chrome.json" },
  { subdir: "firefox", template: "manifest.firefox.json" },
];

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function build() {
  if (await exists(path.join(srcDir, "manifest.json"))) {
    throw new Error(
      "src/manifest.json must not exist — manifests live in manifests/ and are written into dist/<browser>/manifest.json by this script."
    );
  }

  const pkg = await readJson(pkgPath);
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

  await fs.rm(distDir, { recursive: true, force: true });

  for (const { subdir, template } of targets) {
    const out = path.join(distDir, subdir);
    await fs.cp(srcDir, out, { recursive: true });

    const templatePath = path.join(manifestsDir, template);
    const manifest = await readJson(templatePath);
    if (manifest.version && manifest.version !== version) {
      console.warn(
        `[build] ${template} version ${manifest.version} overridden by package.json ${version}`
      );
    }
    manifest.version = version;

    const outManifest = path.join(out, "manifest.json");
    await fs.writeFile(outManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  console.log(
    `Built dist/chrome and dist/firefox from src/ + manifests/ (version ${version} from package.json)`
  );
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
