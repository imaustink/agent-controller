import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

/** AWS SigV4 caps a presigned URL's lifetime at 7 days. */
const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Thrown when the object store is misconfigured or a transfer fails. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

let s3: S3Client | null = null;

function getClient(): S3Client {
  if (s3) return s3;
  if (!config.s3Bucket) throw new StorageError("IMAGE_S3_BUCKET is not set");
  if (!config.s3AccessKeyId || !config.s3SecretAccessKey) {
    throw new StorageError("IMAGE_S3_ACCESS_KEY_ID / IMAGE_S3_SECRET_ACCESS_KEY are not set");
  }
  s3 = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });
  return s3;
}

/** Builds the object key for a job's image, e.g. "images/<jobId>.png". */
export function objectKey(jobId: string, ext = "png"): string {
  const prefix = config.s3Prefix ? `${config.s3Prefix}/` : "";
  return `${prefix}${jobId}.${ext}`;
}

/**
 * Uploads the image bytes and returns a presigned GET URL. The bucket stays
 * private; only this time-limited URL is handed back to the caller.
 */
export async function uploadAndPresign(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const client = getClient();
  const bucket = config.s3Bucket!;

  try {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }),
    );
  } catch (err) {
    throw new StorageError(`upload failed: ${(err as Error).message}`);
  }

  const ttl = Math.min(config.s3PresignTtlSeconds, MAX_PRESIGN_TTL_SECONDS);
  try {
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: ttl,
    });
  } catch (err) {
    throw new StorageError(`presign failed: ${(err as Error).message}`);
  }
}
