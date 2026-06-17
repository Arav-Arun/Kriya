// Upload storage service (Supabase Storage in production, local folder in dev).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { supabase } from '../core/supabase.ts';
import { config } from '../core/env.ts';

export interface StoredObject {
  storagePath: string;
  backend: 'supabase' | 'local';
}

export interface EvidenceStorage {
  readonly backend: 'supabase' | 'local';
  put(filename: string, mimeType: string, bytes: Buffer): Promise<StoredObject>;
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf', 'text/csv': '.csv', 'text/plain': '.txt',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
};

function objectKey(filename: string, mimeType: string): string {
  const ext = EXT_BY_MIME[mimeType] ?? path.extname(filename) ?? '.bin';
  const day = new Date().toISOString().slice(0, 10);
  return `${day}/${randomUUID()}${ext}`;
}

class SupabaseEvidenceStorage implements EvidenceStorage {
  readonly backend = 'supabase' as const;
  constructor(private bucket: string) {}

  async put(filename: string, mimeType: string, bytes: Buffer): Promise<StoredObject> {
    const key = objectKey(filename, mimeType);
    const { error } = await supabase.storage.from(this.bucket).upload(key, bytes, {
      contentType: mimeType, upsert: false,
    });
    if (error) throw new Error(`Supabase Storage upload failed (bucket "${this.bucket}"): ${error.message}`);
    return { storagePath: `supabase://${this.bucket}/${key}`, backend: 'supabase' };
  }
}

class LocalEvidenceStorage implements EvidenceStorage {
  readonly backend = 'local' as const;
  constructor(private root: string) {}

  async put(filename: string, mimeType: string, bytes: Buffer): Promise<StoredObject> {
    if (config.deployed && !config.allowLocalFlueSqlite) {
      throw new Error('Local evidence storage is disabled in deployed mode. Configure KRIYA_EVIDENCE_BUCKET.');
    }
    const uploadDir = path.join(this.root, 'data', 'uploads');
    mkdirSync(uploadDir, { recursive: true });
    const storagePath = path.join(uploadDir, objectKey(filename, mimeType).replace('/', '-'));
    writeFileSync(storagePath, bytes);
    return { storagePath, backend: 'local' };
  }
}

let instance: EvidenceStorage | null = null;

export function evidenceStorage(root = process.cwd()): EvidenceStorage {
  if (!instance) {
    instance = config.evidenceBucket
      ? new SupabaseEvidenceStorage(config.evidenceBucket)
      : new LocalEvidenceStorage(root);
  }
  return instance;
}
