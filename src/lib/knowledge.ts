// Markdown knowledge base access: policies and team playbooks.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tokenize } from './sentinel-db.ts';

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let currentDir = __dirname;
while (currentDir !== path.dirname(currentDir) && !existsSync(path.join(currentDir, 'knowledge'))) {
  currentDir = path.dirname(currentDir);
}
const ROOT = currentDir;

export interface KnowledgeDoc {
  slug: string;
  title: string;
  content: string;
}

function loadDir(dir: string): KnowledgeDoc[] {
  const full = path.join(ROOT, 'knowledge', dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(path.join(full, f), 'utf8');
      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? f;
      return { slug: f.replace(/\.md$/, ''), title, content };
    });
}

export const policies: KnowledgeDoc[] = loadDir('policies');
export const playbooks: KnowledgeDoc[] = loadDir('playbooks');

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

// Category → owning team, per the policy documents' "Assigned Team" sections.
export const TEAM_BY_CATEGORY: Record<string, string> = {
  'Duplicate Charge': 'Disputes Operations',
  'Fraud Transactions': 'Fraud Operations',
  'Card Declined': 'Card Operations',
  'EMI Conversion': 'Customer Service',
  'Rewards': 'Customer Service',
  'Chargeback': 'Disputes Operations',
  'Lost Card': 'Card Operations',
  'KYC': 'Risk Operations',
  'Credit Limit Increase': 'Risk Operations',
  'Card Closure': 'Card Operations',
  'International Transactions': 'Card Operations',
  'Merchant Disputes': 'Disputes Operations',
};

export function getPlaybook(team: string): KnowledgeDoc | undefined {
  const want = team.toLowerCase();
  return playbooks.find((p) => p.title.toLowerCase().includes(want) || p.slug.replace(/-/g, ' ') === want);
}
