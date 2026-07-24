/**
 * Swiss-glass top navigation: frosted white bar, fine hairline, red square
 * mark. Fully public — no accounts, no sign-in.
 */
import { Link, useLocation } from "wouter";

export default function SwissHeader() {
  const [location] = useLocation();

  const nav = [
    { href: "/", label: "Convert" },
    { href: "/history", label: "History" },
  ];

  return (
    <header className="glass-nav sticky top-0 z-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 flex items-stretch justify-between h-16">
        <Link href="/" className="flex items-center gap-3 group">
          {/* red square mark */}
          <span className="block w-4 h-4 bg-primary transition-transform duration-200 group-hover:scale-110" />
          <span className="font-black tracking-tight text-lg leading-none uppercase">
            AWS Bill<span className="text-primary">→</span>BOM
          </span>
        </Link>

        <nav className="flex items-stretch gap-1 py-2">
          {nav.map(n => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center px-5 text-sm font-semibold uppercase tracking-widest transition-colors ${
                location === n.href
                  ? "bg-black text-white"
                  : "hover:bg-black/5"
              }`}>
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
