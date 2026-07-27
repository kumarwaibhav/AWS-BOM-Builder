/**
 * Swiss-glass top navigation: frosted bar, fine hairline, SISL logo.
 * Fully public, no accounts, no sign-in.
 */
import { Link, useLocation } from "wouter";
import SislLogo from "./SislLogo";
import ThemeToggle from "./ThemeToggle";

export default function SwissHeader() {
  const [location] = useLocation();

  const nav = [
    { href: "/", label: "Convert" },
    { href: "/history", label: "History" },
  ];

  return (
    <header className="glass-nav sticky top-0 z-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 flex items-stretch justify-between h-16">
        <div className="flex items-center gap-4 min-w-0">
          <Link href="/" className="flex items-center shrink-0" aria-label="SISL">
            <SislLogo height={24} />
          </Link>
          <span
            className="hidden sm:block w-px h-6 bg-[var(--glass-border-strong)] shrink-0"
            aria-hidden="true"
          />
          <Link href="/" className="hidden sm:flex items-center min-w-0">
            <span className="font-black tracking-tight text-lg leading-none uppercase whitespace-nowrap">
              AWS Bill to BOM
            </span>
          </Link>
        </div>

        <div className="flex items-stretch gap-2 py-2">
          <nav className="flex items-stretch gap-1">
            {nav.map(n => (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center px-4 sm:px-5 text-sm font-semibold uppercase tracking-widest transition-colors duration-200 ${
                  location === n.href
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "hover:bg-black/5 dark:hover:bg-white/10"
                }`}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center pl-1">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
