/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin baked in at build time (architecture §9.2). Empty = same origin (dev proxy). */
  readonly VITE_FEED_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
