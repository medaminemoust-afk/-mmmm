import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    // Suppress benign cross-origin third-party script errors (e.g. YouTube iframe postMessage / telemetry)
    if (event.message === "Script error." || (event.filename && !event.filename.includes(window.location.host))) {
      event.preventDefault();
      return true;
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
