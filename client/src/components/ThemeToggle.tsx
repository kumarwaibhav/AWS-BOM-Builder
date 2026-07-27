/**
 * Light/dark toggle. Sharp-cornered to match the app's control language
 * (glass panels get radius, controls stay square). Sun/moon cross-fade and
 * rotate on switch; hidden entirely if the app is running non-switchable.
 */
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

export default function ThemeToggle() {
  const { theme, toggleTheme, switchable } = useTheme();
  if (!switchable || !toggleTheme) return null;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="relative flex items-center justify-center w-10 h-10 shrink-0 border border-[var(--glass-border-strong)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-200">
      <Sun
        className="w-[18px] h-[18px] absolute transition-all duration-300 rotate-0 scale-100 dark:-rotate-90 dark:scale-0"
        strokeWidth={1.75}
      />
      <Moon
        className="w-[18px] h-[18px] absolute transition-all duration-300 rotate-90 scale-0 dark:rotate-0 dark:scale-100"
        strokeWidth={1.75}
      />
    </button>
  );
}
