import type { Provider } from "../pipeline/types.js";

export type RuntimeAuth = {
  provider: Provider;
  model: string;
  apiKey: string;
};

let auth: RuntimeAuth | null = null;

export const RuntimeAuthStore = {
  set(a: RuntimeAuth) {
    auth = a;
  },
  get() {
    return auth;
  },
  clear() {
    auth = null;
  }
};

