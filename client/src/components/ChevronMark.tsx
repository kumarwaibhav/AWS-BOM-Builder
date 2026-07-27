/**
 * SISL chevron accent mark. Renders the actual brand chevron asset (cropped
 * from the SISL wordmark) rather than a redrawn approximation, so it always
 * matches brand color/shape exactly. Used everywhere the UI previously used
 * a plain CSS square bullet or a typed arrow character: nav wordmark, hero
 * eyebrow, step cards, table indicators, and the footer.
 */
export default function ChevronMark({
  size = 14,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const height = Math.round(size * (152 / 236));
  return (
    <img
      src="/brand/sisl-chevron.png"
      alt=""
      aria-hidden={title ? undefined : "true"}
      title={title}
      width={size}
      height={height}
      draggable={false}
      style={{ width: size, height }}
      className={`inline-block shrink-0 select-none object-contain ${className}`}
    />
  );
}
