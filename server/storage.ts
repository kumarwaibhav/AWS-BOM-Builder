/**
 * Cloudflare R2-backed storage — direct, no third-party proxy.
 * R2 speaks the S3 API, so this uses the same @aws-sdk/client-s3 client as
 * AWS S3 would, just pointed at R2's S3-compatible endpoint with R2
 * credentials. Uploads via PutObjectCommand; downloads via short-lived
 * presigned GET URLs. R2's free tier (10GB storage, no egress fees, no
 * time limit) makes this genuinely free at this app's scale, unlike AWS S3.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

const PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  if (!ENV.r2.accountId || !ENV.r2.accessKeyId || !ENV.r2.secretAccessKey) {
    throw new Error(
      "Storage not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY"
    );
  }
  client = new S3Client({
    // R2 has no regions — "auto" lets Cloudflare route to the nearest location.
    region: "auto",
    endpoint: `https://${ENV.r2.accountId}.r2.cloudflarestorage.com`,
    // R2 only supports path-style addressing (bucket-in-path), not the
    // virtual-hosted-style (bucket-in-subdomain) AWS S3 defaults to.
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENV.r2.accessKeyId,
      secretAccessKey: ENV.r2.secretAccessKey,
    },
  });
  return client;
}

function getBucket(): string {
  if (!ENV.r2.bucket) {
    throw new Error("Storage not configured: set R2_BUCKET");
  }
  return ENV.r2.bucket;
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
  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: data,
      ContentType: contentType,
    })
  );
  return { key };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS }
  );
  return { key, url };
}
