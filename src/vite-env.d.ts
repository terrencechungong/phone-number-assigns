/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FORMFLOW_CRM_API_BASE?: string;
  readonly VITE_FORMFLOW_CRM_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
