import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalDiskDocumentStore, sniffContentType } from '../src/storage.js';
import { SAMPLE_JPEG, SAMPLE_PDF, SAMPLE_PNG } from './helpers.js';

describe('LocalDiskDocumentStore', () => {
  it('stores and reads back files with owner-only permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docs-'));
    const store = new LocalDiskDocumentStore(root);
    const { key, sha256 } = await store.put('kyc/abc', SAMPLE_PDF, 'application/pdf');
    expect(key).toMatch(/^kyc\/abc\/[0-9a-f-]{36}\.pdf$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.get(key)).equals(SAMPLE_PDF)).toBe(true);
    expect((await stat(path.join(root, key))).mode & 0o777).toBe(0o600);
  });

  it('refuses keys that escape the storage root', async () => {
    const store = new LocalDiskDocumentStore(await mkdtemp(path.join(tmpdir(), 'docs-')));
    await expect(store.get('../../etc/passwd')).rejects.toThrow('Invalid storage key');
    await expect(store.put('../x', SAMPLE_PDF, 'application/pdf')).rejects.toThrow('Invalid storage prefix');
  });
});

describe('sniffContentType', () => {
  it('recognises files by their leading bytes', () => {
    expect(sniffContentType(SAMPLE_PDF)).toBe('application/pdf');
    expect(sniffContentType(SAMPLE_JPEG)).toBe('image/jpeg');
    expect(sniffContentType(SAMPLE_PNG)).toBe('image/png');
    expect(sniffContentType(Buffer.from('MZ executable'))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });
});
