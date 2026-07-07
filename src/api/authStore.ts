// Observable auth state (same subscribe/getSnapshot pattern as the other
// stores; consumed via useSyncExternalStore). All network goes through the
// api client.

import { getMe, logout as apiLogout, type MeDto } from "./client";

export interface AuthState {
  /** null = anonymous (or session check still pending). */
  user: MeDto | null;
  /** "loading" until the first /me round-trip settles. */
  status: "loading" | "ready";
}

type Listener = () => void;

export class AuthStore {
  private state: AuthState = { user: null, status: "loading" };
  private listeners = new Set<Listener>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): AuthState => this.state;

  /** Re-check the session cookie against /me. */
  async refresh(): Promise<void> {
    try {
      const user = await getMe();
      this.set({ user, status: "ready" });
    } catch {
      // Backend unreachable: treat as anonymous but settled.
      this.set({ user: null, status: "ready" });
    }
  }

  async logout(): Promise<void> {
    await apiLogout();
    this.set({ user: null, status: "ready" });
  }

  private set(next: AuthState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

/** App-wide singleton; App refreshes it on mount. */
export const authStore = new AuthStore();
