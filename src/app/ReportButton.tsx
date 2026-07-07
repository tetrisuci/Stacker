// "Report" affordance for a segment: a flag button that expands into a tiny
// reason form. Logged-out users get the same login prompt as voting.

import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { authStore } from "../api/authStore";
import { ApiError, createReport } from "../api/client";

export function ReportButton({ segmentId }: { segmentId: string }) {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "sent" } | { kind: "login" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const toggle = () => {
    if (!auth.user) {
      setState({ kind: "login" });
      return;
    }
    setState({ kind: "idle" });
    setOpen((o) => !o);
  };

  const submit = () => {
    setBusy(true);
    createReport({ segmentId, reason: reason.trim() }).then(
      () => {
        setBusy(false);
        setOpen(false);
        setReason("");
        setState({ kind: "sent" });
      },
      (e) => {
        setBusy(false);
        setState({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Report failed.",
        });
      },
    );
  };

  if (state.kind === "sent") {
    return <span className="report-sent">⚑ Reported</span>;
  }

  return (
    <span className="report">
      <button
        type="button"
        className="report-btn"
        title="Report this segment"
        onClick={toggle}
      >
        ⚑
      </button>
      {state.kind === "login" && (
        <span className="vote-login">
          <Link to="/login">Log in</Link> to report
        </span>
      )}
      {open && (
        <span className="report-form">
          <input
            type="text"
            placeholder="What's wrong with it?"
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || reason.trim().length < 3}
            onClick={submit}
          >
            {busy ? "…" : "Send"}
          </button>
        </span>
      )}
      {state.kind === "error" && (
        <span className="report-error">{state.message}</span>
      )}
    </span>
  );
}
