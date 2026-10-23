import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';

export interface StoredObject {
  size: number;
  contentType?: string;
}

/** Object storage port; S3/R2/MinIO speak the same API, so one adapter covers all three. */
export abstract class Storage {
  abstract put(key: string, body: Buffer, contentType: string, opts?: { immutable?: boolean }): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
  abstract head(key: string): Promise<StoredObject | null>;
  abstract deletePrefix(prefix: string): Promise<number>;
  abstract presignPut(key: string, contentType: string, expiresInSec: number): Promise<string>;
  abstract publicUrl(key: string): string;
}

@Injectable()
export class S3Storage extends Storage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.bucket = config.S3_BUCKET;
    this.s3 = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      // MinIO and most self-hosted S3s don't do virtual-host buckets.
      forcePathStyle: Boolean(config.S3_ENDPOINT),
      credentials: config.S3_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } : undefined,
    });
    this.publicBase = (config.S3_PUBLIC_URL ?? `${config.S3_ENDPOINT ?? `https://${this.bucket}.s3.${config.S3_REGION}.amazonaws.com`}/${this.bucket}`).replace(/\/$/, '');
  }

  async put(key: string, body: Buffer, contentType: string, opts: { immutable?: boolean } = {}): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Keys embed the media id and variant, so content at a key never changes → cache forever.
        CacheControl: opts.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  presignPut(key: string, contentType: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresInSec });
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

@Global()
@Module({ providers: [{ provide: Storage, useClass: S3Storage }], exports: [Storage] })
export class StorageModule {}
