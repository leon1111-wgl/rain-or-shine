import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FramedNotice, isFramed } from "./components/FramedNotice";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    {isFramed(window) ? <FramedNotice /> : <App />}
  </StrictMode>,
);
