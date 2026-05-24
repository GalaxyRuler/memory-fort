import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("dashboard UI root element not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
