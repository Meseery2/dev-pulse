import { z } from "zod";
import raw from "../../../config/sources.json";

const deploySignalSchema = z.object({
  kind: z.literal("workflow"),
  workflowNames: z.array(z.string()).min(1),
  branches: z.array(z.string()).min(1),
});

const repoSchema = z.object({
  slug: z.string().regex(/^[^/]+\/[^/]+$/, "repo slug must be owner/name"),
  defaultBranch: z.string(),
  provenance: z.enum(["live", "seeded"]),
  deploySignal: deploySignalSchema,
});

const squadSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  repos: z.array(z.string()),
  codeownersTeams: z.array(z.string()),
});

const accountSchema = z.object({
  username: z.string(),
  role: z.enum(["exec", "squad_lead"]),
  displayName: z.string(),
  squadId: z.string().nullable(),
});

const configSchema = z.object({
  org: z.object({ name: z.string(), kAnonymityFloor: z.number().int().positive() }),
  squads: z.array(squadSchema).min(1),
  repos: z.array(repoSchema).min(1),
  accounts: z.array(accountSchema).min(1),
});

export type DeploySignal = z.infer<typeof deploySignalSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;
export type SquadConfig = z.infer<typeof squadSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type SourcesConfig = z.infer<typeof configSchema>;

function load(): SourcesConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config/sources.json is invalid: ${parsed.error.message}`);
  }
  const config = parsed.data;

  const repoSlugs = new Set(config.repos.map((r) => r.slug));
  for (const squad of config.squads) {
    for (const slug of squad.repos) {
      if (!repoSlugs.has(slug)) {
        throw new Error(`squad "${squad.id}" references unknown repo "${slug}"`);
      }
    }
  }

  const squadIds = new Set(config.squads.map((s) => s.id));
  for (const account of config.accounts) {
    if (account.role === "squad_lead" && (!account.squadId || !squadIds.has(account.squadId))) {
      throw new Error(`account "${account.username}" must reference a known squad`);
    }
    if (account.role === "exec" && account.squadId !== null) {
      throw new Error(`exec account "${account.username}" must not be scoped to a squad`);
    }
  }

  // A repo owned by two squads would double-count deployments at org level.
  const owner = new Map<string, string>();
  for (const squad of config.squads) {
    for (const slug of squad.repos) {
      const existing = owner.get(slug);
      if (existing) throw new Error(`repo "${slug}" is claimed by both "${existing}" and "${squad.id}"`);
      owner.set(slug, squad.id);
    }
  }

  return config;
}

export const sourcesConfig = load();

export function squadForRepo(slug: string): SquadConfig | undefined {
  return sourcesConfig.squads.find((s) => s.repos.includes(slug));
}

export function repoConfig(slug: string): RepoConfig | undefined {
  return sourcesConfig.repos.find((r) => r.slug === slug);
}

export function liveRepos(): RepoConfig[] {
  return sourcesConfig.repos.filter((r) => r.provenance === "live");
}

export function seededRepos(): RepoConfig[] {
  return sourcesConfig.repos.filter((r) => r.provenance === "seeded");
}
