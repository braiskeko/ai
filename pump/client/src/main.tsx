// Wallet adapters (and the base58/borsh code paths they pull in) assume a Node
// `Buffer` global. Polyfill it before anything else in the app touches it.
import { Buffer } from "buffer";
const globalWithBuffer = globalThis as unknown as { Buffer?: unknown };
globalWithBuffer.Buffer ??= Buffer;

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
