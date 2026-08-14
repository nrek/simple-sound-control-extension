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

/**
 * Files that exist only to support Chrome's Tab Capture mode (offscreen
 * document + its bootstrap). Firefox has no `chrome.offscreen` / `tabCapture`
 * API surface, so these get omitted from the Firefox dist entirely.
 */
const FIREFOX_OMIT_FILES = new Set([
  "capture-level-policy.js",
  "offscreen.html",
  "offscreen.js",
]);

const PREPROCESS_EXTS = new Set([".js", ".mjs", ".cjs", ".html"]);

/**
 * Per-target source preprocessor. Recognizes three marker forms:
 *
 *   // SSC_FIREFOX_STRIP_BEGIN
 *   ... Chrome-only code ...
 *   // SSC_FIREFOX_STRIP_ELSE         ← optional
 *   ... Firefox replacement ...
 *   // SSC_FIREFOX_STRIP_END
 *
 * The Chrome target keeps the BEGIN..ELSE region (or BEGIN..END when there's
 * no ELSE) and drops the ELSE..END region. The Firefox target does the
 * inverse — drops BEGIN..ELSE, keeps ELSE..END (or, with no ELSE, drops
 * BEGIN..END entirely). Marker lines themselves are always removed.
 *
 * HTML files use `<!-- SSC_FIREFOX_STRIP_BEGIN -->` etc. — the preprocessor
 * matches the token, not the surrounding comment delimiters.
 */
function preprocessSource(text, target) {
  if (!text.includes("SSC_FIREFOX_STRIP_")) return text;
  const lines = text.split(/\r?\n/);
  const kept = [];
  let region = "outside"; // outside | beforeElse | afterElse
  for (const ln of lines) {
    if (region === "outside") {
      if (ln.includes("SSC_FIREFOX_STRIP_BEGIN")) {
        region = "beforeElse";
        continue;
      }
      kept.push(ln);
      continue;
    }
    if (region === "beforeElse") {
      if (ln.includes("SSC_FIREFOX_STRIP_ELSE")) {
        region = "afterElse";
        continue;
      }
      if (ln.includes("SSC_FIREFOX_STRIP_END")) {
        region = "outside";
        continue;
      }
      // Chrome keeps the "primary" region, Firefox drops it.
      if (target === "chrome") kept.push(ln);
      continue;
    }
    if (region === "afterElse") {
      if (ln.includes("SSC_FIREFOX_STRIP_END")) {
        region = "outside";
        continue;
      }
      // Firefox keeps the "else" region, Chrome drops it.
      if (target === "firefox") kept.push(ln);
      continue;
    }
  }
  return kept.join("\n");
}

/**
 * Walk `dir` recursively and apply `transform` to every regular file. Used
 * after the initial `fs.cp` to either preprocess source files or remove
 * Chrome-only assets from the Firefox dist.
 */
async function walkAndTransform(dir, transform) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndTransform(full, transform);
      continue;
    }
    if (entry.isFile()) {
      await transform(full, entry.name);
    }
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

    await walkAndTransform(out, async (full, name) => {
      if (subdir === "firefox" && FIREFOX_OMIT_FILES.has(name)) {
        await fs.rm(full);
        return;
      }
      const fileExt = path.extname(name);
      if (!PREPROCESS_EXTS.has(fileExt)) return;
      const original = await fs.readFile(full, "utf8");
      const next = preprocessSource(original, subdir);
      if (next !== original) {
        await fs.writeFile(full, next, "utf8");
      }
    });

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
