import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const manifestsDir = path.join(root, "manifests");
const pkgPath = path.join(root, "package.json");

// `.xpi` is Firefox's convention; Chrome Web Store expects `.zip`. Both files
// are plain ZIPs at the binary level, so the extension differs only by target.
const targets = [
  { subdir: "chrome", template: "manifest.chrome.json", ext: "zip" },
  { subdir: "firefox", template: "manifest.firefox.json", ext: "xpi" },
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

function zipDir(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve(archive.pointer()));
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        console.warn(`[zip] ${err.message}`);
      } else {
        reject(err);
      }
    });
    archive.on("error", reject);
    archive.pipe(output);
    // Pack the contents of srcDir at the archive root (no parent folder),
    // which is what both Chrome Web Store and Firefox AMO expect.
    archive.directory(srcDir, false);
    archive.finalize();
  });
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

  const baseName = (typeof pkg.name === "string" && pkg.name) || "extension";
  const skipPackage = process.argv.includes("--no-package");
  const packagedFiles = [];

  for (const { subdir, template, ext } of targets) {
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

    if (!skipPackage) {
      const packagedName = `${baseName}-${version}-${subdir}.${ext}`;
      const packagedPath = path.join(distDir, packagedName);
      const bytes = await zipDir(out, packagedPath);
      packagedFiles.push({ packagedName, bytes });
    }
  }

  console.log(
    `Built dist/chrome and dist/firefox from src/ + manifests/ (version ${version} from package.json)`
  );
  if (packagedFiles.length) {
    for (const { packagedName, bytes } of packagedFiles) {
      const kb = (bytes / 1024).toFixed(1);
      console.log(`Packaged dist/${packagedName} (${kb} KB)`);
    }
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
