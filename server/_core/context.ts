import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

/**
 * No user accounts in this app -- every bill is tracked by an anonymous
 * sessionId. That id is now resolved server-side from a signed, httpOnly
 * cookie (see server/_core/sessionCookie.ts) rather than trusted from a
 * client-supplied request parameter, so ctx.sessionId is always the
 * server-verified value for this request.
 */
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  sessionId: string;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    // Populated by createSessionMiddleware in app.ts, which always runs
    // before this on the /api/trpc path -- never undefined in practice.
    sessionId: opts.req.sessionId ?? "",
  };
}
