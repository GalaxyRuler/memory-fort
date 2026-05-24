export interface TimelineScrubberProps {
  maxAgeDays: number;
  onChange: (days: number) => void;
  maxRange?: number;
}

const PRESETS = [
  { days: 1, label: "1d" },
  { days: 7, label: "1w" },
  { days: 30, label: "1mo" },
  { days: 90, label: "3mo" },
  { days: 365, label: "1y" },
  { days: 10000, label: "All" },
];

export function TimelineScrubber({ maxAgeDays, onChange, maxRange = 365 }: TimelineScrubberProps) {
  return (
    <div className="glass-blur absolute bottom-16 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Show:</span>
      <input
        type="range"
        min={1}
        max={maxRange}
        value={Math.min(maxAgeDays, maxRange)}
        onChange={(event) => onChange(Number.parseInt(event.currentTarget.value, 10))}
        className="w-48 accent-primary"
        aria-label="Timeline scrubber"
      />
      <span className="min-w-[3.5rem] font-mono text-xs text-text-primary">
        {maxAgeDays >= 10000 ? "All" : `${maxAgeDays}d`}
      </span>
      <div className="ml-2 flex gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(preset.days)}
            className="rounded px-2 py-0.5 font-mono text-[10px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
