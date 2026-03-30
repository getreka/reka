/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_RAG_API_URL: string;
  readonly VITE_API_KEY: string;
  readonly VITE_DEFAULT_PROJECT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
