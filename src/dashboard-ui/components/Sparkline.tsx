export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  strokeColor?: string;
}

export function Sparkline({
  data,
  width = 80,
  height = 24,
  className,
  strokeColor = "currentColor",
}: SparklineProps) {
  if (data.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data
    .map((value, index) => `${index * stepX},${height - ((value - min) / range) * height}`)
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      className={className}
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
