// The trainer as a routed view. The board markup that used to live in
// index.html renders here (same element ids, so the existing CSS applies
// unchanged), and the imperative bootstrap that used to run at module scope
// in main.tsx now runs in a useEffect: mount on route enter, dispose on
// leave. Panels keep the repo's observable-store + useSyncExternalStore
// pattern — they just receive the stores from the live controller.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getReplayFile, getSegment } from "../api/client";
import { StatsPanel } from "../game/StatsPanel";
import {
  ReplayPanel,
  type AutoLoad,
  type LoadedReplay,
} from "../replay/ReplayPanel";
import { ComparisonPanel } from "../session/ComparisonPanel";
import { KeyHintsHud } from "../session/KeyHintsHud";
import { ControlsPanel, SettingsPanel } from "../settings/SettingsPanel";
import { startTrainer, type TrainerController } from "./bootstrap";
import { PublishSegmentPanel } from "./PublishSegmentPanel";

export function TrainerView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const learnerInfoRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [controller, setController] = useState<TrainerController | null>(null);
  // The loaded replay + the timeline's WindowSelection, surfaced by the
  // ReplayPanel so the publish panel can bind to the same window.
  const [loaded, setLoaded] = useState<LoadedReplay | null>(null);
  const [window, setWindow] = useState<{ start: number; end: number } | null>(
    null,
  );
  // "Practice" deep link (/train?segment=<id>): fetch the segment + its
  // replay file from the API, then run it through the panel's normal load
  // path and auto-start a session over the segment's window.
  const [searchParams] = useSearchParams();
  const segmentId = searchParams.get("segment");
  const [autoLoad, setAutoLoad] = useState<AutoLoad | null>(null);
  const [practiceError, setPracticeError] = useState<string | null>(null);

  useEffect(() => {
    if (!segmentId) {
      setAutoLoad(null);
      setPracticeError(null);
      return;
    }
    let cancelled = false;
    setPracticeError(null);
    (async () => {
      try {
        const segment = await getSegment(segmentId);
        const file = await getReplayFile(segment.replayId);
        const text = await file.text();
        if (cancelled) return;
        setAutoLoad({
          key: segment.id,
          text,
          filename: segment.replay.filename,
          window: { start: segment.startPiece, end: segment.endPiece },
          autoStart: true,
        });
      } catch {
        if (!cancelled)
          setPracticeError(
            "Could not load that segment — it may have been removed.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const trainer = startTrainer({
      canvas,
      learnerInfoEl: learnerInfoRef.current,
      statusEl: statusRef.current,
    });
    setController(trainer);
    return () => {
      setController(null);
      trainer.dispose();
    };
  }, []);

  return (
    <main>
      {practiceError && <p className="practice-error">{practiceError}</p>}
      <div className="stage">
        <div className="board-area">
          <div className="board-group">
            {/* Learner board — you play here. The pro's placements are shown
                as target ghosts on this board, so no second board is needed. */}
            <div className="play-col">
              <div className="board-title" id="learner-title">
                YOU
              </div>
              {/* Stats sit left of the board and bottom-align to the
                  playfield, matching TETR.IO's layout. */}
              <div className="board-with-stats">
                <div id="stats-root">
                  {controller && <StatsPanel store={controller.statsStore} />}
                </div>
                <canvas id="board" tabIndex={0} ref={canvasRef} />
              </div>
              <p id="learner-info" className="board-info" ref={learnerInfoRef} />
              {controller && (
                <KeyHintsHud
                  store={controller.keyHintsStore}
                  settings={controller.settingsStore}
                />
              )}
              <p id="status" className="status" ref={statusRef} />
            </div>
            {/* Replay loader sits right of the board. */}
            <div id="replay-root">
              {controller && (
                <ReplayPanel
                  onReviewSnapshot={controller.onReviewSnapshot}
                  onLoadedChange={setLoaded}
                  onWindowChange={setWindow}
                  onStartSession={controller.startSession}
                  onEndSession={controller.endSession}
                  comparison={controller.comparisonStore}
                  autoLoad={autoLoad}
                />
              )}
            </div>
          </div>
          {/* Comparison feedback sits on its own row below the board. */}
          <div id="comparison-root">
            {controller && (
              <ComparisonPanel
                store={controller.comparisonStore}
                onRetry={controller.retryPiece}
              />
            )}
          </div>
        </div>
        <div className="side-col">
          {loaded && window && (
            <PublishSegmentPanel loaded={loaded} window={window} />
          )}
          <div id="controls-root">
            {controller && <ControlsPanel store={controller.settingsStore} />}
          </div>
          <div id="settings-root">
            {controller && <SettingsPanel store={controller.settingsStore} />}
          </div>
        </div>
      </div>
    </main>
  );
}
