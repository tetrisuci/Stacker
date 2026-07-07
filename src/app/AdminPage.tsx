// /admin — the moderation queue: reports newest first, each with its target
// and (for segments) hide/remove/restore actions driving segments.status.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { authStore } from "../api/authStore";
import {
  listReports,
  moderateSegment,
  type ModerateAction,
  type ReportDto,
} from "../api/client";

const ACTIONS: Array<{ action: ModerateAction; label: string }> = [
  { action: "hide", label: "Hide" },
  { action: "remove", label: "Remove" },
  { action: "restore", label: "Restore" },
];

function ReportRow({ report }: { report: ReportDto }) {
  // Segment status is kept locally so a moderation click reflects at once.
  const [status, setStatus] = useState(report.segment?.status ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (action: ModerateAction) => {
    if (!report.segment) return;
    setBusy(true);
    setError(null);
    moderateSegment(report.segment.id, action).then(
      (updated) => {
        setBusy(false);
        setStatus(updated.status);
      },
      () => {
        setBusy(false);
        setError("Action failed.");
      },
    );
  };

  return (
    <li className="admin-report">
      <p className="admin-report-head">
        <span className="admin-report-when">
          {new Date(report.createdAt).toLocaleString()}
        </span>
        <span>
          reported by <b>{report.reporterUsername ?? "anonymous"}</b>
        </span>
      </p>
      <p className="admin-report-reason">“{report.reason}”</p>
      {report.segment ? (
        <div className="admin-report-target">
          <span>
            segment{" "}
            <Link to={`/segment/${report.segment.id}`}>
              {report.segment.title}
            </Link>{" "}
            <span className={`admin-status admin-status-${status}`}>
              {status}
            </span>
          </span>
          <span className="admin-actions">
            {ACTIONS.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                disabled={busy}
                onClick={() => act(action)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      ) : report.replay ? (
        <div className="admin-report-target">
          <span>
            replay{" "}
            <Link to={`/replay/${report.replay.id}`}>
              {report.replay.playerUsername} — {report.replay.filename}
            </Link>
          </span>
        </div>
      ) : null}
      {error && <p className="report-error">{error}</p>}
    </li>
  );
}

export function AdminPage() {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  const [reports, setReports] = useState<ReportDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = auth.user?.isAdmin ?? false;
  useEffect(() => {
    if (!isAdmin) return;
    listReports().then(setReports, () =>
      setError("Could not load the report queue."),
    );
  }, [isAdmin]);

  if (auth.status === "loading") {
    return (
      <section className="page">
        <p className="browse-loading">Loading…</p>
      </section>
    );
  }
  if (!auth.user || !auth.user.isAdmin) {
    return (
      <section className="page">
        <h2>Admin</h2>
        <p>Admins only.</p>
      </section>
    );
  }

  return (
    <section className="page admin-page">
      <h2>Report queue</h2>
      {error && <p className="browse-error">{error}</p>}
      {reports && reports.length === 0 && (
        <p className="browse-empty">No reports. Quiet day.</p>
      )}
      {reports && reports.length > 0 && (
        <ul className="admin-reports">
          {reports.map((r) => (
            <ReportRow key={r.id} report={r} />
          ))}
        </ul>
      )}
    </section>
  );
}
