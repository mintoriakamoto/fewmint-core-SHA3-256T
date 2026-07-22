import { Ajv2020 } from 'ajv/dist/2020.js';
import packSchema from './industry-pack.schema.json' with { type: 'json' };

export interface PackRegistries {
  readonly modules: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
  readonly workflows: ReadonlySet<string>;
  readonly dashboards: ReadonlySet<string>;
  readonly integrations: ReadonlySet<string>;
}

export interface InstalledPack {
  readonly industry: string;
  readonly version: string;
  readonly installed_at: string;
  readonly modules: readonly string[];
  readonly agents: readonly string[];
  readonly workflows: readonly string[];
}

export class InstallError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Industry Pack install failed: ${problems.join('; ')}`);
    this.name = 'InstallError';
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateManifest = ajv.compile(packSchema);

interface PackManifest {
  industry: string;
  version: string;
  modules: string[];
  entities: string[];
  agents: string[];
  workflows: string[];
  dashboards: string[];
  integrations: string[];
}

const installed = new Map<string, InstalledPack>();

/**
 * SaaS Factory install stages 1–2 (spec 07 §3): schema-validate the manifest,
 * then resolve every reference against the platform registries. Unresolved
 * references fail INSTALL, not runtime. Idempotent per industry+version.
 */
export function installPack(manifestInput: unknown, registries: PackRegistries): InstalledPack {
  if (!validateManifest(manifestInput)) {
    throw new InstallError(
      (validateManifest.errors ?? []).map(
        (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      ),
    );
  }
  const manifest = manifestInput as unknown as PackManifest;
  const key = `${manifest.industry}@${manifest.version}`;
  const existing = installed.get(key);
  if (existing) return existing;

  const problems: string[] = [];
  const check = (kind: keyof PackRegistries, names: readonly string[]) => {
    for (const name of names) {
      if (!registries[kind].has(name)) problems.push(`unresolved ${kind.slice(0, -1)}: ${name}`);
    }
  };
  check('modules', manifest.modules);
  check('agents', manifest.agents);
  check('workflows', manifest.workflows);
  check('dashboards', manifest.dashboards);
  check('integrations', manifest.integrations);
  if (problems.length > 0) throw new InstallError(problems);

  const record: InstalledPack = {
    industry: manifest.industry,
    version: manifest.version,
    installed_at: new Date().toISOString(),
    modules: [...manifest.modules],
    agents: [...manifest.agents],
    workflows: [...manifest.workflows],
  };
  installed.set(key, record);
  return record;
}
