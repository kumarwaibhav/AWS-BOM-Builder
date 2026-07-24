/**
 * Vercel serverless entrypoint (bundled at build time, see package.json's
 * "build:vercel-api" script and vercel.json's buildCommand). Vercel's Node.js
 * runtime invokes an exported Express app directly (it's callable as
 * (req, res)), so no listen() call and no Vite/static-file serving here —
 * the built client in dist/public is served straight from Vercel's static
 * hosting/CDN (see vercel.json's outputDirectory), not proxied through this
 * function.
 *
 * This file is esbuild-bundled into a single self-contained api/index.js at
 * build time (dependencies marked --packages=external so they still resolve
 * from node_modules at runtime). Bundling — rather than relying on Vercel's
 * own per-file TypeScript-to-function pipeline — avoids two real failure
 * modes that pipeline has with a multi-file backend: (1) it type-checks each
 * file with its own isolated settings, which can reject valid code our own
 * project tsconfig accepts (seen in practice with the AWS SDK v3 client's
 * generic `.send()` overloads); (2) it does not always bundle cross-directory
 * relative imports into one file, and Node's native ESM loader then fails to
 * resolve extensionless relative imports like "../server/_core/app" at
 * runtime (ERR_MODULE_NOT_FOUND). A single pre-bundled file sidesteps both.
 */
import "dotenv/config";
import { createApiApp } from "./app";

export default createApiApp();
