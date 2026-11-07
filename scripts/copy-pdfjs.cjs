const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = path.join(__dirname, "..", "node_modules", "pdfjs-dist");
const destinationRoot = path.join(__dirname, "..", "dist", "pdfjs");

fs.mkdirSync(destinationRoot, { recursive: true });

for (const [source, destination] of [
  ["pdf.min.mjs", "pdf.mjs"],
  ["pdf.worker.min.mjs", "pdf.worker.mjs"],
]) {
  fs.copyFileSync(path.join(sourceRoot, "build", source), path.join(destinationRoot, destination));
}

for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  fs.cpSync(path.join(sourceRoot, directory), path.join(destinationRoot, directory), { recursive: true });
}

fs.cpSync(
  path.join(__dirname, "..", "webview"),
  path.join(__dirname, "..", "dist", "webview"),
  { recursive: true },
);
