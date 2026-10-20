import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DocumentContentType = 'image/jpeg' | 'image/png' | 'application/pdf';

/** Private document storage for KYC and delivery proofs. Nothing stored here is ever served from a public URL. */
export interface DocumentStore {
  readonly name: string;
  put(prefix: string, bytes: Buffer, contentType: DocumentContentType): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Buffer>;
}

const EXTENSIONS: Record<DocumentContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

function newKey(prefix: string, contentType: DocumentContentType): string {
  if (!/^[a-z0-9/_-]+$/.test(prefix)) throw new Error('Invalid storage prefix');
  return `${prefix}/${randomUUID()}.${EXTENSIONS[contentType]}`;
}

/**
 * DEVELOPMENT ONLY. Stores files on the local disk. Config validation refuses it in staging/production,
 * where a private object-storage bucket is required.
 */
export class LocalDiskDocumentStore implements DocumentStore {
  readonly name = 'local_disk';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(prefix: string, bytes: Buffer, contentType: DocumentContentType) {
    const key = newKey(prefix, contentType);
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return { key, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
}

/** Test helper. */
export class MemoryDocumentStore implements DocumentStore {
  readonly name = 'memory';
  readonly files = new Map<string, Buffer>();

  async put(prefix: string, bytes: Buffer, contentType: DocumentContentType) {
    const key = newKey(prefix, contentType);
    this.files.set(key, bytes);
    return { key, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    const file = this.files.get(key);
    if (!file) throw new Error('Not found');
    return file;
  }
}

/** Checks the file's leading bytes so a renamed executable cannot pass as a licence scan. */
export function sniffContentType(bytes: Buffer): DocumentContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
