// Builds and starts the app on http://localhost:3000, on Windows, macOS and
// Linux alike. Needs Node.js 22 or newer with Corepack (it ships with Node);
// everything else is installed here.
//
//   node start.mjs           build, then start
//   node start.mjs --dev     the development server instead (rebuilds as you edit)
//
// start.cmd (double-click on Windows) and start.sh (Mac, Linux) run this file.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Node.js ${process.version} is too old; this app needs Node.js 22 or newer. https://nodejs.org`);
  process.exit(1);
}

// `shell: true` so Windows finds corepack.cmd and yarn's shims the way a typed
// command would; the arguments are fixed words, so nothing needs quoting.
function run(words) {
  const result = spawnSync(words.join(" "), { stdio: "inherit", shell: true });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

if (spawnSync("corepack --version", { shell: true, stdio: "ignore" }).status !== 0) {
  console.error("Corepack is missing. It ships with Node.js 22; on an older install run: npm install -g corepack");
  process.exit(1);
}

if (!existsSync(".env.local")) {
  copyFileSync(".env.example", ".env.local");
  console.log("Created .env.local from .env.example. Every setting in it is optional; broker credentials are entered in the browser.");
}

run(["corepack", "yarn", "install", "--frozen-lockfile"]);

// Loopback only: a username and password are all that stands between the port
// and the configured accounts, so the port stays off the network by default.
if (process.argv.includes("--dev")) {
  run(["corepack", "yarn", "dev", "-H", "127.0.0.1", "-p", "3000"]);
} else {
  run(["corepack", "yarn", "build"]);
  console.log("\nStarting on http://localhost:3000 — Ctrl-C stops it.");
  run(["corepack", "yarn", "start", "-H", "127.0.0.1", "-p", "3000"]);
}
