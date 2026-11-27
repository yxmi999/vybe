// Worker — the Auto-Pilot mark: a worker in a safety hard hat, the one doing
// the clipping while you're away. Drawn on lucide's 24px grid (2px round
// strokes, currentColor) so it sits naturally next to lucide icons, and takes
// the same props the nav passes them (size / className / strokeWidth).
import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "ref"> & { size?: number | string; strokeWidth?: number | string };

export default function Worker({ size = 24, strokeWidth = 2, ...rest }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {/* hard hat: solid dome + brim */}
      <path d="M7 8.5a5 5 0 0 1 10 0z" fill="currentColor" />
      <path d="M5.5 8.5h13" />
      {/* face under the brim */}
      <path d="M8.8 9.5a3.4 3.4 0 1 0 6.4 0" />
      {/* shoulders */}
      <path d="M5 21.5V20a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1.5" />
      {/* safety-vest V collar */}
      <path d="m10 15 2 2.5 2-2.5" />
    </svg>
  );
}
