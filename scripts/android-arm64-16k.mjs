// After `tauri android init`: phone APK is arm64-v8a only, native libs stored
// uncompressed so AGP 8.5.1+ can 16 KB zip-align them.
// https://developer.android.com/guide/practices/page-sizes
import fs from "node:fs";
import path from "node:path";

const root = "src-tauri/gen/android/app";
const files = ["build.gradle.kts", "build.gradle"]
  .map((name) => path.join(root, name))
  .filter((file) => fs.existsSync(file));

if (files.length === 0) {
  console.error("android app gradle not found");
  process.exit(1);
}

for (const file of files) {
  let text = fs.readFileSync(file, "utf8");
  const kts = file.endsWith(".kts");
  if (!text.includes("useLegacyPackaging")) {
    const block = kts
      ? "\n    packaging {\n        jniLibs {\n            useLegacyPackaging = false\n        }\n    }\n"
      : "\n    packaging {\n        jniLibs {\n            useLegacyPackaging false\n        }\n    }\n";
    if (!text.includes("android {")) {
      console.error(`no android block in ${file}`);
      process.exit(1);
    }
    text = text.replace("android {", `android {${block}`);
  }
  text = text.replace(/abiFilters\s*\+=\s*listOf\([^)]*\)/g, 'abiFilters += listOf("arm64-v8a")');
  text = text.replace(/abiFilters\s+"[^"]+"(?:\s*,\s*"[^"]+")*/g, 'abiFilters "arm64-v8a"');
  fs.writeFileSync(file, text);
  console.log(`patched ${file}`);
}
