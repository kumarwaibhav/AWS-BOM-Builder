/**
 * 404: kept in the same Swiss-glass language as the rest of the app rather
 * than a generic boilerplate page.
 */
import { Button } from "@/components/ui/button";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";
import SwissHeader from "@/components/SwissHeader";
import SwissFooter from "@/components/SwissFooter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      <div className="app-backdrop" aria-hidden="true" />
      <SwissHeader />
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="glass w-full max-w-lg p-10 sm:p-12 text-center">
          <div className="flex items-center justify-center gap-2 mb-6">
            <span className="text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground">
              Not Found
            </span>
          </div>
          <AlertCircle className="w-12 h-12 text-primary mx-auto mb-6" strokeWidth={1.5} />
          <h1 className="text-6xl font-black tracking-tighter uppercase mb-3">404</h1>
          <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
            This page does not exist. It may have been moved or the link may be incorrect.
          </p>
          <Button
            onClick={() => setLocation("/")}
            className="rounded-none bg-black text-white hover:bg-primary dark:bg-white dark:text-black uppercase tracking-widest text-xs font-bold h-12 px-8">
            <Home className="w-4 h-4" /> Go Home
          </Button>
        </div>
      </main>
      <SwissFooter />
    </div>
  );
}
