// App shell: nav + routes. The trainer (the whole pre-router app) lives at
// /train, mounted/torn down by <TrainerView>'s effect; everything else is a
// routed page. The nav reflects the Discord session via the auth store.

import { useEffect, useSyncExternalStore } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { authStore } from "../api/authStore";
import { TrainerView } from "../trainer/TrainerView";
import { AdminPage } from "./AdminPage";
import { BrowsePage } from "./BrowsePage";
import { PrivacyPage, TermsPage } from "./LegalPages";
import { ReplayPage, SegmentPage } from "./ReplayPage";
import {
  LoginPage,
  NotFoundPage,
  PlayerPage,
  UploadPage,
} from "./placeholders";

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? "active" : "";

/** "Admin" nav entry, only for moderators. */
function AdminLink() {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  if (!auth.user?.isAdmin) return null;
  return (
    <NavLink to="/admin" className={navClass}>
      Admin
    </NavLink>
  );
}

/** Right side of the nav: the Discord user when logged in, else a link. */
function NavUser() {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  if (auth.user) {
    return (
      <span className="nav-right nav-user">
        {auth.user.avatarUrl && (
          <img src={auth.user.avatarUrl} alt="" className="nav-avatar" />
        )}
        {auth.user.username}
        <button
          type="button"
          className="nav-logout"
          onClick={() => void authStore.logout()}
        >
          Log out
        </button>
      </span>
    );
  }
  return (
    <span className="nav-right">
      <NavLink to="/login" className={navClass}>
        Log in
      </NavLink>
    </span>
  );
}

export function App() {
  // One session check on mount; the store broadcasts to all subscribers.
  useEffect(() => {
    void authStore.refresh();
  }, []);

  return (
    <BrowserRouter>
      <header className="app-nav">
        <NavLink to="/train" className="brand">
          Stacker
        </NavLink>
        <NavLink to="/train" className={navClass}>
          Train
        </NavLink>
        <NavLink to="/browse" className={navClass}>
          Browse
        </NavLink>
        <NavLink to="/upload" className={navClass}>
          Upload
        </NavLink>
        <AdminLink />
        <NavUser />
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/train" replace />} />
        <Route path="/train" element={<TrainerView />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/replay/:id" element={<ReplayPage />} />
        <Route path="/segment/:id" element={<SegmentPage />} />
        <Route path="/player/:username" element={<PlayerPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <footer className="app-footer">
        <NavLink to="/terms">Terms</NavLink>
        <NavLink to="/privacy">Privacy</NavLink>
      </footer>
    </BrowserRouter>
  );
}
