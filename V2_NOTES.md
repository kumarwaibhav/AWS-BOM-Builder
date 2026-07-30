# V2 development branch

This branch (`v2`) is the working branch for Version 2 of AWS Bill to BOM.

Version 1 (on `main`, live at aws-bom-builder.vercel.app) converts an AWS
consumption bill PDF into an editable Excel BOM, so presales can use it as
the AWS-side input when building an AWS-to-GCP (or AWS-to-Azure) cost
comparison.

Commits here deploy to their own Vercel preview URL and do not affect the
`main` branch or the production deployment. Merge to `main` only when a
V2 milestone is ready to go live.

## Preview deployments need their own environment variables

Vercel scopes environment variables per environment. If the database
credentials are set for Production only, every preview deployment builds and
serves the app fine but fails at the first DB call:

    GET /api/trpc/bills.list 500
    {"level":"error","message":"tRPC error","context":{"message":"Database not available"}}

The variables the API needs on **Preview** as well as Production:

    POSTGRES_URL, POSTGRES_PRISMA_URL, POSTGRES_URL_NON_POOLING, DIRECT_URL,
    POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET,
    SESSION_SECRET, GEMINI_API_KEY, GEMINI_MODEL

Two things to know once they are set:

1. **A redeploy is required.** Changing a variable does not retro-fit existing
   deployments. Redeploying *production* does not rebuild the *preview* -
   push a commit to the branch, or hit Redeploy on that preview deployment.

2. **Preview and Production currently share one Supabase project.** That is
   deliberate for now: no V2 feature needs a schema change, because
   `bills.getInsights` aggregates on demand from `bom_items`. It does mean
   test uploads on a preview land in the same database production reads, so
   purge them afterwards. Give Preview its own Supabase project before any
   migration that drops, renames or retypes a column - at that point the two
   environments stop being compatible and the shared database becomes a
   liability rather than a convenience.
