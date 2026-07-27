export const ENV = {
  // DATABASE_URL is the app-native name (used by .env.example, Docker, local
  // dev). POSTGRES_URL is what Supabase's native Vercel integration syncs
  // automatically on every deploy (including password rotations) — preferred
  // when present so Vercel deployments never need a manually-copied secret.
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    // Server-only secret — bypasses Row Level Security entirely, so it must
    // never be sent to the client or logged. Only imported by server/ code.
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    bucket: process.env.SUPABASE_STORAGE_BUCKET ?? "",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    // gemini-2.0-flash was shut down by Google on 2026-06-01. Confirmed
    // against Google's own pricing page (2026-07-27) that gemini-3.6-flash is
    // their current newest stable Flash model and is free-tier eligible.
    model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
  },
};
