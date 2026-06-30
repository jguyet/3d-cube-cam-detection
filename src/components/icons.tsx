// Small inline SVG icon set (stroke-based, inherit currentColor).
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Isometric cube — brand / "3D" marker. */
export function CubeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" />
      <path d="M3 7l9 4.5L21 7" />
      <path d="M12 11.5V21.5" />
    </svg>
  );
}

/** Stacked layers — "choose your level". */
export function LayersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 17 12 21.5 21 17" />
    </svg>
  );
}

/** Rotating cube — "observe in 3D". */
export function Rotate3dIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" />
      <path d="M3 7l9 4.5L21 7" />
      <path d="M12 11.5V21.5" />
      <path d="M16.5 4.5a7 7 0 0 1 2 3" opacity="0.5" />
    </svg>
  );
}

/** Trophy — "memorise & progress". */
export function TrophyIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h2.5a2.5 2.5 0 0 1-2.5 4" />
      <path d="M7 5H4.5A2.5 2.5 0 0 0 7 9" />
      <path d="M12 13v4" />
      <path d="M8.5 20.5h7" />
      <path d="M10 17h4l.5 3.5h-5L10 17Z" />
    </svg>
  );
}

/** Check inside a rosette — completion. */
export function SuccessIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 2 2.2 1.6 2.7-.3 1.1 2.5 2.5 1.1-.3 2.7L22 12l-1.6 2.2.3 2.7-2.5 1.1-1.1 2.5-2.7-.3L12 22l-2.2-1.6-2.7.3-1.1-2.5L3.5 17l.3-2.7L2 12l1.6-2.2-.3-2.7 2.5-1.1L7 3.3l2.7.3L12 2Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}
