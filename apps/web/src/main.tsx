import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FrickProvider } from "@frick/react";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrickProvider>
      <App />
    </FrickProvider>
  </StrictMode>,
);
