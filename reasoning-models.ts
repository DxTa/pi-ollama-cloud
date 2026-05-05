import type { ThinkingLevelMap } from "./thinking.ts";

export interface CatalogPattern {
  match: string;
  map: ThinkingLevelMap;
}

export interface ThinkingCatalog {
  version: number;
  default: ThinkingLevelMap;
  models: Record<string, ThinkingLevelMap>;
  patterns: CatalogPattern[];
}

export const CATALOG: ThinkingCatalog = {
  version: 1,
  default: {
    off: "none",
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
  },
  models: {
    "deepseek-v4-pro": {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    },
  },
  patterns: [
    {
      match: "gpt-oss*",
      map: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
      },
    },
    {
      match: "qwen3*",
      map: {
        off: "none",
        minimal: null,
        low: null,
        medium: "medium",
        high: null,
        xhigh: null,
      },
    },
    {
      match: "deepseek*",
      map: {
        off: "none",
        minimal: null,
        low: null,
        medium: "medium",
        high: null,
        xhigh: null,
      },
    },
  ],
};
