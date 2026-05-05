import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { CATALOG } from "./reasoning-models.ts";

export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

type ThinkingModelData = {
  capabilities?: string[];
  details?: { family?: string };
};

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function resolveThinkingLevelMap(
  modelId: string,
  data: ThinkingModelData,
): ProviderModelConfig["thinkingLevelMap"] {
  if (!data.capabilities?.includes("thinking")) return undefined;

  const normalizedId = modelId.toLowerCase();
  const exact = CATALOG.models[normalizedId] ?? CATALOG.models[modelId];
  if (exact) return exact;

  const family = data.details?.family?.toLowerCase();
  for (const entry of CATALOG.patterns) {
    if (globMatches(entry.match, normalizedId) || (family && globMatches(entry.match, family))) {
      return entry.map;
    }
  }

  return CATALOG.default;
}
