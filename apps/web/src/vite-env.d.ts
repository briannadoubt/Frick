/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRICK_HTTP?: string;
  readonly VITE_FRICK_WS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
