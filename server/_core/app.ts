/**
 * Builds the API-only Express app: security headers, body parsing, rate
 * limiting, and the tRPC router mounted at /api/trpc. No listen(), no
 * static/Vite serving — those are added on top by whichever entrypoint uses
 * this (the traditional long-running server in index.ts, or the Vercel
 * serverless function in /api/index.ts), so the same middleware stack is
 * never duplicated or allowed to drift between deployment targets.
 */
import express, { type Express } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { createSessionMiddleware } from "./sessionCookie";
import { logger } from "./logger";
import * as db from "../db";

export function createApiApp(): Express {
  const app = express();

  // Trust the first proxy hop. Both Vercel and a typical single-layer
  // reverse-proxy deployment (Docker behind nginx/ALB) sit exactly one hop
  // in front of this app, so req.ip / X-Forwarded-For need this to resolve
  // to the real client IP. Without it, express-rate-limit refuses to trust
  // X-Forwarded-For and logs an ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning
  // on every request instead of rate-limiting by real client IP.
  app.set("trust proxy", 1);

  // Security headers. CSP is disabled here because Vite's dev middleware
  // injects inline scripts for HMR; a strict CSP belongs at the CDN/edge
  // layer in production instead of fighting the dev server.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Body parser size limit. This is a backstop, not the real ceiling: Vercel
  // Functions hard-cap the whole request body at 4.5 MB (platform limit, not
  // configurable), which rejects oversized requests before Express even sees
  // them. 6mb here just keeps local/non-Vercel deployments from accepting
  // something Vercel never would -- MAX_PDF_BYTES in bills.ts (~3 MB raw,
  // ~4 MB base64-encoded) is what actually governs in production.
  app.use(express.json({ limit: "6mb" }));
  app.use(express.urlencoded({ limit: "6mb", extended: true }));

  // Rate limit the API surface: uploads are the expensive path (PDF parse +
  // LLM enrichment + S3 + Excel generation), so keep this conservative.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api/trpc", apiLimiter);

  // Resolves/issues the signed httpOnly session cookie (see sessionCookie.ts)
  // before the tRPC handler runs, so every procedure's ctx.sessionId is
  // already server-verified -- no procedure trusts a client-supplied id.
  app.use("/api/trpc", createSessionMiddleware({ hasLegacyHistory: db.hasBillsForSession }));

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError({ error, path }) {
        logger.error("tRPC error", { path, code: error.code, message: error.message });
      },
    })
  );

  return app;
}
