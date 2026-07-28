# V2 development branch

This branch (`v2`) is the working branch for Version 2 of AWS Bill to BOM.

Version 1 (on `main`, live at aws-bom-builder.vercel.app) converts an AWS
consumption bill PDF into an editable Excel BOM, so presales can use it as
the AWS-side input when building an AWS-to-GCP (or AWS-to-Azure) cost
comparison.

Commits here deploy to their own Vercel preview URL and do not affect the
`main` branch or the production deployment. Merge to `main` only when a
V2 milestone is ready to go live.
