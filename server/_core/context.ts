import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

/**
 * No authentication in this app — every bill is tracked by a client-generated
 * sessionId (see shared/const.ts), not a user account. Context stays minimal.
 */
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
  };
}
