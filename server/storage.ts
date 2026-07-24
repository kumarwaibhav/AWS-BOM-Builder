/**
 * AWS S3-backed storage — direct, no third-party proxy.
 * Uploads via PutObjectCommand; downloads via short-lived presigned GET URLs.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

const PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  if (!ENV.aws.accessKeyId || !ENV.aws.secretAccessKey) {
    throw new Error(
      "Storage not configured: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
    );
  }
  client = new S3Client({
    region: ENV.aws.region,
    credentials: {
      accessKeyId: ENV.aws.accessKeyId,
      secretAccessKey: ENV.aws.secretAccessKey,
    },
  });
  return client;
}

function getBucket(): string {
  if (!ENV.aws.bucket) {
    throw new Error("Storage not configured: set AWS_S3_BUCKET");
  }
  return ENV.aws.bucket;
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
