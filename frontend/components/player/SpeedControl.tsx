"use client";

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: SliderControlProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-raised-hi) ${pct}%)`,
        }}
      />
      <span className="font-mono text-[11px] tabular-nums text-text-dim w-10 text-right shrink-0">
        {value.toFixed(2).replace(/\.?0+$/, "")}
        {label}
      </span>
    </div>
  );
}

/** Backwards-compat wrapper */
export function SpeedControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (rate: number) => void;
}) {
  return (
    <SliderControl
      label="x"
      value={value}
      min={0.5}
      max={3}
      step={0.05}
      onChange={onChange}
    />
  );
}
