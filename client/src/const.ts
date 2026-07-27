/**
 * Legacy client-side session id key. The app no longer generates or trusts
 * this value directly -- sessions are now server-issued, signed httpOnly
 * cookies (see server/_core/sessionCookie.ts). This key is only read once,
 * client-side, to offer any pre-existing localStorage value as
 * X-Legacy-Session-Id so existing bill history can be adopted into the new
 * cookie rather than silently orphaned (see main.tsx). Never written to by
 * new sessions.
 */
export const SESSION_STORAGE_KEY = "aws-bom-sessionId";
