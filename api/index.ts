/**
 * Vercel serverless entrypoint. Vercel's Node.js runtime invokes an exported
 * Express app directly (it's callable as (req, res)), so no listen() call
 * and no Vite/static-file serving here — the built client in dist/public is
 * served straight from Vercel's static hosting/CDN (see vercel.json's
 * outputDirectory), not proxied through this function.
 */
import "dotenv/config";
import { createApiApp } from "../server/_core/app";

export default createApiApp();
