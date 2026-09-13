// Wallet adapters (and the base58/borsh code paths they pull in) assume a Node
// `Buffer` global. Polyfill it before anything else in the app touches it.
import { Buffer } from "buffer";
const globalWithBuffer = globalThis as unknown as { Buffer?: unknown };
globalWithBuffer.Buffer ??= Buffer;

/*
  A chunk that vanished under a running tab means a new version was deployed
  while this page was open: the safe answer is to load the new one, once, rather
  than leave a blank screen behind. The flag keeps a genuinely broken deploy from
  turning into a reload loop.
*/
const RELOADED_KEY = "nx_reloaded_for_chunk";
window.addEventListener("vite:preloadError", () => {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return;
    sessionStorage.setItem(RELOADED_KEY, "1");
  } catch {
    /* storage unavailable: reload anyway, the page is unusable as it is */
  }
  window.location.reload();
});

import { createRoot } from "react-dom/client";
import App from "./App";
import { Splash } from "@/components/Splash";
import "./index.css";

createRoot(document.getElementById("root")!).render(<>
      <Splash />
      <App />
    </>);
