// App entry: mount the routed shell. The trainer's imperative bootstrap now
// lives in src/trainer/bootstrap.ts and runs when /train mounts.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const rootEl = document.querySelector("#root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
