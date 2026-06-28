import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const appRoot = path.resolve(process.argv[2] ?? process.env.MEMORY_FORT_APP_PATH ?? process.cwd());
const vendorDir = path.join(appRoot, "vendor", "sqlite-vec", "win32-arm64");
const manifestPath = path.join(vendorDir, "manifest.json");
const binaryPath = path.join(vendorDir, "vec0.dll");

if (!path.isAbsolute(appRoot)) {
  throw new Error(`app root is not absolute: ${appRoot}`);
}
if (!existsSync(manifestPath)) {
  throw new Error(`missing sqlite-vec manifest: ${manifestPath}`);
}
if (!existsSync(binaryPath)) {
  throw new Error(`missing sqlite-vec binary: ${binaryPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest?.target?.platform !== "win32" || manifest?.target?.arch !== "arm64") {
  throw new Error(
    `manifest target ${manifest?.target?.platform}/${manifest?.target?.arch}; expected win32/arm64`,
  );
}
if (manifest?.target?.file !== "vec0.dll") {
  throw new Error(`manifest file ${manifest?.target?.file}; expected vec0.dll`);
}

const size = statSync(binaryPath).size;
if (manifest?.output?.size !== size) {
  throw new Error(`size mismatch: manifest=${manifest?.output?.size} actual=${size}`);
}

const sha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
if (manifest?.output?.sha256 !== sha256) {
  throw new Error(`sha256 mismatch: manifest=${manifest?.output?.sha256} actual=${sha256}`);
}

const machine = readPeMachine(binaryPath);
if (manifest?.target?.peMachine !== "ARM64" || machine !== "ARM64") {
  throw new Error(`PE machine mismatch: manifest=${manifest?.target?.peMachine} actual=${machine}`);
}

console.log(`[vendored-sqlite-vec] ok path=${binaryPath} sha256=${sha256} size=${size}`);

function readPeMachine(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") return "unknown";
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    return "unknown";
  }
  const value = bytes.readUInt16LE(peOffset + 4);
  if (value === 0xaa64) return "ARM64";
  if (value === 0x8664) return "AMD64";
  if (value === 0x014c) return "I386";
  return `0x${value.toString(16)}`;
}
