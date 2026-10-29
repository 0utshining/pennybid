import fs from 'fs';
import path from 'path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Where product files live. Local disk by default; S3-compatible when configured. */
export interface ObjectStorage {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  remove(key: string): Promise<void>;
  /** Origins that should be added to img-src and media-src. */
  assetOrigins(): string[];
}

const KEY_RE = /^media\/\d+\/[a-zA-Z0-9._-]+$/;

export function assertStorageKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('invalid storage key');
  return key;
}

export class LocalStorage implements ObjectStorage {
  readonly name = 'local' as const;
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  async put(key: string, body: Buffer, _contentType: string): Promise<string> {
    const safe = assertStorageKey(key);
    const dest = path.join(this.root, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    return '/uploads/' + safe;
  }
  async remove(key: string): Promise<void> {
    const safe = assertStorageKey(key);
    const dest = path.join(this.root, safe);
    const resolved = path.resolve(dest);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) return;
    fs.rmSync(resolved, { force: true });
  }
  assetOrigins(): string[] { return []; }
}

export class S3Storage implements ObjectStorage {
  readonly name = 's3' as const;
  private client: S3Client;
  private bucket: string;
  private base: string;
  constructor() {
    this.bucket = process.env.S3_BUCKET || '';
    const key = process.env.S3_ACCESS_KEY_ID || '';
    const secret = process.env.S3_SECRET_ACCESS_KEY || '';
    this.base = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!this.bucket || !key || !secret || !this.base) {
      throw new Error('S3 storage requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_PUBLIC_BASE_URL');
    }
    this.client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });
  }
  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    const safe = assertStorageKey(key);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: safe,
      Body: body,
      ContentType: contentType,
    }));
    return `${this.base}/${safe}`;
  }
  async remove(key: string): Promise<void> {
    const safe = assertStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safe }));
  }
  assetOrigins(): string[] {
    try { return [new URL(this.base).origin]; } catch { return []; }
  }
}

export function createStorage(uploadDir: string): ObjectStorage {
  const driver = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (driver === 's3' || (!driver && process.env.S3_BUCKET)) return new S3Storage();
  if (driver && driver !== 'local') throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use local or s3.`);
  return new LocalStorage(uploadDir);
}
