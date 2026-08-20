/**
 * The Contentstack mark, inlined as SVG (mirrors public/contentstack-logo.svg, which is kept
 * around solely to serve as the favicon). Rendered by SiteLogo as its default fallback so the
 * mark shows up everywhere a logo slot exists, instead of the generic Phosphor Hexagon.
 *
 * The fill is intentionally Contentstack's brand purple (#7C4DFF), not the Venus accent
 * (#6c5ce7) — that divergence is a recorded, accepted decision, not a bug.
 */
export default function ContentstackMark({
  size,
  className,
}: {
  size: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      role="img"
      aria-label="Contentstack"
      className={className}
    >
      <g fill="#7C4DFF">
        <rect x="70" y="40" width="68" height="15" rx="7.5" />
        <rect x="45" y="60" width="81" height="15" rx="7.5" />
        <rect x="23" y="80" width="89" height="15" rx="7.5" />
        <rect x="23" y="100" width="89" height="15" rx="7.5" />
        <rect x="45" y="120" width="81" height="15" rx="7.5" />
        <rect x="70" y="140" width="68" height="15" rx="7.5" />
        <rect x="118" y="101" width="68" height="15" rx="7.5" />
        <rect x="130" y="121" width="81" height="15" rx="7.5" />
        <rect x="144" y="141" width="89" height="15" rx="7.5" />
        <rect x="144" y="161" width="89" height="15" rx="7.5" />
        <rect x="130" y="181" width="81" height="15" rx="7.5" />
        <rect x="118" y="201" width="68" height="15" rx="7.5" />
      </g>
    </svg>
  )
}
