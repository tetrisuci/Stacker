// Placeholder pages for the community routes. Real implementations land with
// the API client; these keep the router shell honest in the meantime.

import { useSyncExternalStore } from "react";
import { useParams } from "react-router-dom";
import { authStore } from "../api/authStore";
import { discordLoginUrl } from "../api/client";

export function PlayerPage() {
  const { username } = useParams<{ username: string }>();
  return (
    <section className="page">
      <h2>{username}</h2>
      <p>Replays and segments by this player will appear here.</p>
    </section>
  );
}

export function UploadPage() {
  return (
    <section className="page">
      <h2>Upload a replay</h2>
      <p>Solo .ttr uploads will go to the community library from here.</p>
    </section>
  );
}

export function LoginPage() {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  return (
    <section className="page">
      <h2>Log in</h2>
      {auth.user ? (
        <p>
          Logged in as <b>{auth.user.username}</b>.
        </p>
      ) : (
        <p>
          {/* Full-page navigation: the backend 307s to Discord and back. */}
          <a className="discord-login" href={discordLoginUrl()}>
            Continue with Discord
          </a>
        </p>
      )}
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="page">
      <h2>Not found</h2>
      <p>Nothing lives at this address.</p>
    </section>
  );
}
