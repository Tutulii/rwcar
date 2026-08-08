import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { documentRecords, type RwcarDb } from '@rwcar/db';
import type { MultipartFile } from '@fastify/multipart';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';

export class EvidenceService {
  private readonly client: S3Client;
  private readonly isCloudflareR2: boolean;

  constructor(private readonly config: ApiConfig, private readonly db: RwcarDb) {
    if (!config.S3_ENDPOINT || !config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
      throw new Error('Evidence storage is not configured');
    }
    this.isCloudflareR2 = new URL(config.S3_ENDPOINT).hostname.endsWith('.r2.cloudflarestorage.com');
    if (this.isCloudflareR2 && config.S3_KMS_KEY_ID) {
      throw new Error('S3_KMS_KEY_ID is not supported by Cloudflare R2; use R2 managed encryption or SSE-C');
    }
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    });
  }

  async upload(assetAddress: string, uploadedBy: string, file: MultipartFile) {
    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new AppError(400, 'EMPTY_DOCUMENT', 'Evidence document is empty');
    const digest = `0x${createHash('sha256').update(buffer).digest('hex')}`;
    const objectKey = `evidence/${assetAddress.toLowerCase()}/${randomUUID()}`;
    const useKms = Boolean(this.config.S3_KMS_KEY_ID);
    const encryption = this.isCloudflareR2
      ? {}
      : {
          ServerSideEncryption: useKms ? 'aws:kms' as const : 'AES256' as const,
          ...(useKms ? { SSEKMSKeyId: this.config.S3_KMS_KEY_ID } : {}),
        };
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.S3_BUCKET!,
      Key: objectKey,
      Body: buffer,
      ContentType: file.mimetype,
      Metadata: { sha256: digest.slice(2), originalName: encodeURIComponent(file.filename).slice(0, 900) },
      ...encryption,
    }));
    const [record] = await this.db.insert(documentRecords).values({
      assetAddress: assetAddress.toLowerCase(),
      objectKey,
      contentHash: digest,
      encryptedDataKey: this.isCloudflareR2
        ? 'R2:MANAGED-ENCRYPTION'
        : useKms ? `SSE-KMS:${this.config.S3_KMS_KEY_ID}` : 'SSE-S3:AES256',
      mimeType: file.mimetype,
      uploadedBy: uploadedBy.toLowerCase(),
    }).returning();
    return record;
  }
}
