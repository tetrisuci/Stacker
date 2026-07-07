// Templated Terms of Service and Privacy Policy pages. The structure covers
// what the app actually does today (Discord login, replay uploads,
// votes/reports).

const SITE_NAME = "Stacker";
const LAST_UPDATED = "July 6, 2026";

export function TermsPage() {
  return (
    <section className="page legal-page">
      <h2>Terms of Service</h2>
      <p className="legal-updated">Last updated: {LAST_UPDATED}</p>

      <p>
        Welcome to {SITE_NAME} (&ldquo;the Service&rdquo;). By accessing or
        using the Service you agree to these terms. If you do not agree, do
        not use the Service.
      </p>

      <h3>1. The Service</h3>
      <p>
        The Service is a free training and replay-sharing tool for stacking
        games. It is an independent project and is not affiliated with,
        endorsed by, or sponsored by the developers of any game whose replays
        it supports.
      </p>

      <h3>2. Accounts</h3>
      <p>
        Signing in is handled through Discord. You are responsible for
        activity that happens under your account. We may suspend or remove
        accounts that violate these terms.
      </p>

      <h3>3. User content</h3>
      <p>
        You may upload replays and interact with content (votes, reports). By
        uploading, you confirm you have the right to share the replay and you
        grant the Service a non-exclusive license to store, display, and
        distribute it as part of the Service. You keep ownership of your
        content, and you may request its removal at any time.
      </p>

      <h3>4. Acceptable use</h3>
      <p>You agree not to:</p>
      <ul>
        <li>upload content that is illegal, harmful, or infringes others&rsquo; rights;</li>
        <li>attempt to disrupt, overload, or gain unauthorized access to the Service;</li>
        <li>impersonate other players or misrepresent the origin of a replay;</li>
        <li>abuse moderation features such as reports or votes.</li>
      </ul>

      <h3>5. Moderation</h3>
      <p>
        Moderators may remove content or restrict accounts at their
        discretion to keep the Service usable and safe.
      </p>

      <h3>6. Disclaimer and liability</h3>
      <p>
        The Service is provided &ldquo;as is&rdquo; without warranties of any
        kind. To the maximum extent permitted by law, the operators of the
        Service are not liable for any damages arising from your use of it,
        including loss of data or replays.
      </p>

      <h3>7. Changes</h3>
      <p>
        We may update these terms from time to time. Continued use of the
        Service after changes take effect constitutes acceptance of the new
        terms.
      </p>
    </section>
  );
}

export function PrivacyPage() {
  return (
    <section className="page legal-page">
      <h2>Privacy Policy</h2>
      <p className="legal-updated">Last updated: {LAST_UPDATED}</p>

      <p>
        This policy describes what {SITE_NAME} collects, why, and what your
        choices are.
      </p>

      <h3>1. What we collect</h3>
      <ul>
        <li>
          <b>Discord account info</b> — when you sign in with Discord we
          receive your Discord ID, username, and avatar. We do not receive
          your email, password, or messages.
        </li>
        <li>
          <b>Content you submit</b> — replays you upload, plus votes and
          reports you make.
        </li>
        <li>
          <b>Session data</b> — a session cookie to keep you logged in, and
          basic technical logs (such as IP address and request timestamps)
          for security and debugging.
        </li>
      </ul>

      <h3>2. How we use it</h3>
      <p>
        We use this data only to operate the Service: authenticating you,
        attributing uploads to your account, powering community features, and
        moderating content. We do not sell your data or use it for
        advertising.
      </p>

      <h3>3. Sharing</h3>
      <p>
        Uploaded replays and your public profile (username and avatar) are
        visible to other users. We do not share your data with third parties
        except as required to run the Service (hosting providers) or comply
        with the law.
      </p>

      <h3>4. Retention and deletion</h3>
      <p>
        We keep your data while your account is active. You can request
        deletion of your account and uploaded content at any time, and we
        will remove it within a reasonable period.
      </p>

      <h3>5. Cookies</h3>
      <p>
        The Service uses a single session cookie for login. No third-party
        tracking or analytics cookies are used.
      </p>

      <h3>6. Children</h3>
      <p>
        The Service is not directed at children under 13 (or the minimum age
        required in your country), and we do not knowingly collect their
        data.
      </p>

      <h3>7. Changes</h3>
      <p>
        If this policy changes materially, we will note the update on this
        page with a new &ldquo;last updated&rdquo; date.
      </p>
    </section>
  );
}
