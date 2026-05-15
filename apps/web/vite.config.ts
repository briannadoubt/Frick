import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ConfigEnv, type Plugin } from "vite";
import {
  buildWebSecurityHeaders,
  formatStaticWebSecurityHeaders,
  type WebSecurityHeaderOptions,
} from "./src/security-headers.js";

const defaultDemoHttpEndpoint = "http://127.0.0.1:4099";

export default defineConfig((env) => {
  const endpoints = resolveDemoEndpoints(env);

  return {
    plugins: [react(), emitStaticSecurityHeaders(endpoints)],
    server: {
      headers: buildWebSecurityHeaders({ ...endpoints, command: "serve" }),
    },
    preview: {
      headers: buildWebSecurityHeaders({ ...endpoints, command: "preview" }),
    },
  };
});

function emitStaticSecurityHeaders(endpoints: Omit<WebSecurityHeaderOptions, "command">): Plugin {
  return {
    name: "frick-static-security-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: formatStaticWebSecurityHeaders(
          buildWebSecurityHeaders({ ...endpoints, command: "preview" }),
        ),
      });
    },
  };
}

function resolveDemoEndpoints(env: ConfigEnv): Omit<WebSecurityHeaderOptions, "command"> {
  const loaded = loadEnv(env.mode, process.cwd(), "");
  const demoHttpEndpoint = loaded.VITE_FRICK_HTTP ?? defaultDemoHttpEndpoint;
  const demoWsEndpoint = loaded.VITE_FRICK_WS ?? syncEndpointForHttp(demoHttpEndpoint);
  return { demoHttpEndpoint, demoWsEndpoint };
}

function syncEndpointForHttp(httpEndpoint: string): string {
  const url = new URL(httpEndpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/_frick/sync`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
