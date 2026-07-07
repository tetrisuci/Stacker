import { useSyncExternalStore } from "react";
import type { StatsStore } from "./statsStore";

export function StatsPanel({ store }: { store: StatsStore }) {
  const stats = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div className="stats-panel">
      <StatRow
        label="Pieces"
        value={String(stats.pieces)}
        rate={`${stats.pps.toFixed(2)}/s`}
        rateLabel="PPS"
      />
      <StatRow
        label="Attack"
        value={String(stats.attack)}
        rate={`${stats.apm.toFixed(2)}/m`}
        rateLabel="APM"
      />
      <StatRow
        label="Keys"
        value={String(stats.keys)}
        rate={`${stats.kpp.toFixed(2)}/p`}
        rateLabel="KPP"
      />
    </div>
  );
}

function StatRow({
  label,
  value,
  rate,
  rateLabel,
}: {
  label: string;
  value: string;
  rate: string;
  rateLabel: string;
}) {
  return (
    <div className="stat-row">
      <div className="stat-label">{label}</div>
      <div className="stat-values">
        <span className="stat-value">{value}</span>
        <span className="stat-rate">
          <span className="stat-rate-label">{rateLabel}</span>
          {rate}
        </span>
      </div>
    </div>
  );
}
