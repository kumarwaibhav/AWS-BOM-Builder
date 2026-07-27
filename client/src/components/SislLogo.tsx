/**
 * Theme-aware SISL wordmark. Dark background gets the white-text lockup,
 * light background gets the dark-text lockup, so the logo always has
 * correct contrast against the surrounding glass surface.
 */
import { useTheme } from "@/contexts/ThemeContext";

export default function SislLogo({
  height = 26,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  const { theme } = useTheme();
  const src = theme === "dark" ? "/brand/sisl-logo-dark.png" : "/brand/sisl-logo-light.png";

  return (
    <img
      src={src}
      alt="SISL"
      height={height}
      draggable={false}
      style={{ height, width: "auto" }}
      className={`inline-block select-none ${className}`}
    />
  );
}
