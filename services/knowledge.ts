// Local markdown search for internal bank policy documents.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../core/queries.ts';

// Resolve project root containing the policies/ folder.
let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (ROOT !== path.dirname(ROOT) && !existsSync(path.join(ROOT, 'policies'))) {
  ROOT = path.dirname(ROOT);
}

export interface KnowledgeDoc {
  slug: string;
  title: string;
  content: string;
}

function loadDir(dir: string): KnowledgeDoc[] {
  const full = path.join(ROOT, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(path.join(full, f), 'utf8');
      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? f;
      return { slug: f.replace(/\.md$/, ''), title, content };
    });
}

export const policies: KnowledgeDoc[] = loadDir('policies');

export function searchPolicies(query: string, limit = 3): KnowledgeDoc[] {
  const tokens = tokenize(query);
  return policies
    .map((doc) => {
      const title = doc.title.toLowerCase();
      const body = doc.content.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (title.includes(tok)) score += 10;
        score += Math.min(body.split(tok).length - 1, 5);
      }
      return { doc, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.doc);
}
