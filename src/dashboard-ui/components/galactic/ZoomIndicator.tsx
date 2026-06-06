import type { GalacticZoomLevel } from "../GalacticCanvas.js";

const LEVELS: Array<{ level: GalacticZoomLevel; label: string }> = [
  { level: 0, label: "GALACTIC" },
  { level: 1, label: "SOLAR SYSTEM" },
  { level: 2, label: "PLANETARY" },
];

export function ZoomIndicator({
  level,
  onChange,
}: {
  level: GalacticZoomLevel;
  onChange: (level: GalacticZoomLevel) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface/80 p-1 font-mono text-[10px] shadow-lg backdrop-blur">
      {LEVELS.map((item) => (
        <button
          key={item.level}
          type="button"
          className={
            item.level === level
              ? "rounded bg-primary px-2 py-1 text-background"
              : "rounded px-2 py-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          }
          onClick={() => onChange(item.level)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
