/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOW_JEV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
