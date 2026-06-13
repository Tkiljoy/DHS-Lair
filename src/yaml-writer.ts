import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

/**
 * Set or clear the `model:` field in agents/<id>/agent.yaml. Preserves the
 * rest of the document (comments, ordering, formatting) via the `yaml` package's
 * Document API. Pass `null` for `model` to remove the override and let the
 * agent fall through to DEFAULT_AGENT_MODEL.
 */
export function setAgentModel(agentId: string, model: string | null): void {
  if (!/^[a-z0-9_-]+$/i.test(agentId)) {
    throw new Error(`invalid agent id: ${agentId}`);
  }
  const yamlPath = path.join(AGENTS_DIR, agentId, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`agent.yaml not found for '${agentId}' at ${yamlPath}`);
  }
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const doc = YAML.parseDocument(raw);
  if (model === null || model === '') {
    doc.delete('model');
  } else {
    doc.set('model', model);
  }
  fs.writeFileSync(yamlPath, doc.toString(), 'utf8');
}
