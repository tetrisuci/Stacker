import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The @haelp/teto engine references `chalk` on an optional console-rendering
// path (`.text` / `colorMap`) that this app never uses. `chalk` is a Node-only
// package and drags in `node:*` builtins, so we alias it to a tiny browser-safe
// shim to keep it out of the browser bundle. The shim is a passthrough proxy so
// any `chalk.xxx(...)` style call still returns its input string.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      chalk: new URL("./src/shims/chalk.ts", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
