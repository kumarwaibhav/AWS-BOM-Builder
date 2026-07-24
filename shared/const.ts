/** Shared constants between client and server. Auth-related constants were
 * removed along with the login flow — this app is anonymous, tracked only by
 * a client-generated sessionId (see client/src/const.ts). */
export const AXIOS_TIMEOUT_MS = 30_000;
