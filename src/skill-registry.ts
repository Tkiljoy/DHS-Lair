import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

export interface SkillEntry {
  id: string;
  folder: string;
  skill_md_path: string;
  /** First-line H1 if present. */
  title: string;
  /** First paragraph after the title. */
  blurb: string;
}

function readSkill(folder: string): SkillEntry | null {
  const skillMdPath = path.join(folder, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;
  const text = fs.readFileSync(skillMdPath, 'utf8');
  const id = path.basename(folder);
  const lines = text.split(/\r?\n/);
  const titleLine = lines.find(l => l.trim().startsWith('# ')) ?? `# ${id}`;
  const title = titleLine.replace(/^#\s+/, '').trim();
  const afterTitle = text.split(titleLine)[1] ?? '';
  const blurb = afterTitle.split(/\n\n/).map(s => s.trim()).find(Boolean) ?? '';
  return { id, folder, skill_md_path: skillMdPath, title, blurb };
}

export function loadSkills(): Map<string, SkillEntry> {
  const out = new Map<string, SkillEntry>();
  if (!fs.existsSync(SKILLS_DIR)) return out;
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const skill = readSkill(path.join(SKILLS_DIR, e.name));
    if (skill) out.set(skill.id, skill);
  }
  return out;
}

export function summarizeSkillsForAgent(skills: Map<string, SkillEntry>, ids: string[]): string {
  if (ids.length === 0) return '';
  const lines: string[] = ['## Skills available to this agent', ''];
  for (const id of ids) {
    const s = skills.get(id);
    if (!s) {
      lines.push(`- ${id}: (skill folder missing)`);
      continue;
    }
    lines.push(`- **${s.title}** (\`skills/${s.id}/\`): ${s.blurb}`);
  }
  return lines.join('\n');
}
