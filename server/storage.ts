/**
 * Supabase Storage-backed storage — direct, no third-party proxy.
 * Uses the service-role key (a server-only secret that bypasses Row Level
 * Security) since this app has no per-user auth — access control happens at
 * the application layer (sessionId ownership checks in bills.ts), not via
 * Supabase RLS policies. This key must never reach the client bundle; it is
 * only imported here, in server/ code.
 *
 * Uploads via Storage .upload(); downloads via short-lived signed URLs
 * (createSignedUrl), functionally equivalent to S3/R2 presigned GET URLs.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ENV } from "./_core/env";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  if (!ENV.supabase.url || !ENV.supabase.serviceRoleKey) {
    throw new Error(
      "Storage not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  client = createClient(ENV.supabase.url, ENV.supabase.serviceRoleKey, {
    auth: {
      // Backend-only usage in a stateless serverless function — there is no
      // session to persist and no storage (localStorage/cookies) to persist
      // it to.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

function getBucket(): string {
  if (!ENV.supabase.bucket) {
    throw new Error("Storage not configured: set SUPABASE_STORAGE_BUCKET");
  }
  return ENV.supabase.bucket;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string }> {
  const key = normalizeKey(relKey);
  const { error } = await getClient()
    .storage.from(getBucket())
    .upload(key, data, {
      contentType,
      // Matches the prior S3/R2 PutObject semantics: always succeeds, even
      // if an object at this key already exists. Collisions are practically
      // impossible anyway since keys embed a random nanoid segment.
      upsert: true,
    });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
  return { key };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const { data, error } = await getClient()
    .storage.from(getBucket())
    .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`Storage signed URL failed: ${error?.message ?? "unknown error"}`);
  }
  return { key, url: data.signedUrl };
}
