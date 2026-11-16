/** Build-time variables (Vite). Only VITE_* variables are exposed to extension code. */
interface ImportMetaEnv {
  /** Backend API base URL, e.g. https://api.example.com/api/v1. Required for production builds. */
  readonly VITE_API_URL?: string;
  /** Optional URL of the web dashboard (PWA), linked from Settings. */
  readonly VITE_DASHBOARD_URL?: string;
}
