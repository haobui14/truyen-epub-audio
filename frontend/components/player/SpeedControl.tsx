"use client";

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  accent?: "indigo" | "emerald";
}

export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  accent = "indigo",
}: SliderControlProps) {
  const pct = ((value - min) / (max - min)) * 100;

  const fill = accent === "indigo" ? "#6366f1" : "#10b981";
  const track = "rgb(209 213 219)"; // gray-300

  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={`flex-1 h-1.5 rounded-full appearance-none cursor-pointer ${accent === "emerald" ? "accent-emerald" : ""}`}
        style={{
          background: `linear-gradient(to right, ${fill} ${pct}%, ${track} ${pct}%)`,
        }}
      />
      <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 tabular-nums w-10 text-right shrink-0">
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
