// Network boundary rule: src/api/client.ts is the ONLY module that talks to
// the backend — the fetch mirror of the engine-adapter rule. Everything else
// must go through it, so error handling, credentials, and the API origin live
// in exactly one place.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

// client.ts is the boundary itself; this test names the patterns it bans;
// vite-env.d.ts merely *types* the env var (no network).
const ALLOWED = new Set([
  "api/client.ts",
  "api/boundary.test.ts",
  "vite-env.d.ts",
]);

const BANNED = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\s*\(/,
  /\bnew\s+WebSocket\b/,
  /localhost:8000/,
  /VITE_API_URL/,
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

describe("api client boundary", () => {
  it("no src module other than api/client.ts touches fetch or the API origin", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of BANNED) {
        if (pattern.test(text)) {
          offenders.push(`${rel} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
