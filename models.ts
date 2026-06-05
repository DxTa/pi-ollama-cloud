import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolve as resolveThinkingLevelMap } from "./thinking-levels.ts";
import { concurrentMap, fetchJsonWithTimeout, getContextLength } from "./utils.ts";

// ---------------------------------------------------------------------------
// Estimated per-token pricing ($ per 1M tokens)
// ---------------------------------------------------------------------------
// Ollama Cloud uses subscription pricing (Free / Pro $20/mo / Max $100/mo)
// rather than per-token billing. These estimates are based on equivalent
// model pricing from pricepertoken.com and direct provider APIs so that the
// /cost report shows comparable usage costs. They do NOT reflect actual
// charges — your Ollama Cloud subscription covers usage up to plan limits.
//
// Sources:
//   DeepSeek:  pricepertoken.com/pricing-page/provider/deepseek
//   GLM/Zhipu: pricepertoken.com (z-ai provider)
//   MiniMax:   pricepertoken.com/pricing-page/provider/minimax
//   Qwen:      pricepertoken.com (qwen provider page + deepseek-vs-qwen comparison)
//   Kimi:      pricepertoken.com (moonshot/kimi provider + model comparison pages)
//   Gemma/Gemini: pricepertoken.com (google provider)
//   GPT-OSS:   pricepertoken.com (openai provider)
//   Others:    OpenRouter closest equivalents + pricepertoken.com nearest match
// ---------------------------------------------------------------------------

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Pricing lookup keyed by model ID (exact match) or prefix patterns.
 * Values are $ per 1M tokens. cacheRead/cacheWrite default to provider-
 * specific ratios when not specified (typically 10%/125% of input).
 */
const MODEL_PRICING: Record<string, Partial<ModelPrice>> = {
  // ── DeepSeek (openrouter.ai) ──────────────────────────────────────
  "deepseek-v3.1": {
    input: 0.21,
    output: 0.79,
    cacheRead: 0.042,
    cacheWrite: 0.21,
  },
  "deepseek-v3.2": { input: 0.2288, output: 0.3432, cacheRead: 0.0229 },
  "deepseek-v4-flash": { input: 0.0983, output: 0.1966, cacheRead: 0.0098 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.0435 },

  // ── GLM / Zhipu (openrouter.ai z-ai) ───────────────────────────────
  "glm-4.6": { input: 0.43, output: 1.74, cacheRead: 0.043 },
  "glm-4.7": { input: 0.4, output: 1.75, cacheRead: 0.04 },
  "glm-5": { input: 0.6, output: 1.92, cacheRead: 0.06 },
  "glm-5.1": { input: 0.98, output: 3.08, cacheRead: 0.098 },

  // ── GPT-OSS / OpenAI (openrouter.ai) ──────────────────────────────
  "gpt-oss:20b": { input: 0.029, output: 0.14 },
  "gpt-oss:120b": { input: 0.039, output: 0.18 },

  // ── Gemma (openrouter.ai google) ──────────────────────────────────
  "gemma3:4b": { input: 0.04, output: 0.08 },
  "gemma3:12b": { input: 0.04, output: 0.13 },
  "gemma3:27b": { input: 0.08, output: 0.16 },
  gemma4: { input: 0.06, output: 0.33 }, // 26B A4B IT
  "gemma4:31b": { input: 0.12, output: 0.36 },

  // ── Gemini (openrouter.ai google) ──────────────────────────────────
  "gemini-3-flash-preview": { input: 0.5, output: 3.0, cacheRead: 0.1 },

  // ── Kimi / Moonshot (openrouter.ai moonshotai) ──────────────────────
  "kimi-k2": { input: 0.57, output: 2.3 },
  "kimi-k2.5": { input: 0.4, output: 1.9 },
  "kimi-k2.6": { input: 0.684, output: 3.42 },
  "kimi-k2-thinking": { input: 0.6, output: 2.5 },

  // ── MiniMax (openrouter.ai minimax) ────────────────────────────────
  "minimax-m2": { input: 0.255, output: 1.0, cacheRead: 0.03 },
  "minimax-m2.1": { input: 0.29, output: 0.95, cacheRead: 0.03 },
  "minimax-m2.5": { input: 0.15, output: 1.15, cacheRead: 0.03 },
  "minimax-m2.7": { input: 0.279, output: 1.2, cacheRead: 0.0279 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.03 },

  // ── Mistral (openrouter.ai mistralai) ─────────────────────────────
  "mistral-large-3": { input: 0.5, output: 1.5, cacheRead: 0.05 },
  "ministral-3:3b": { input: 0.1, output: 0.1 },
  "ministral-3:8b": { input: 0.15, output: 0.15 },
  "ministral-3:14b": { input: 0.2, output: 0.2 },

  // ── Nemotron / Nvidia (openrouter.ai nvidia) ────────────────────────
  "nemotron-3-nano": { input: 0.05, output: 0.2 },
  "nemotron-3-super": { input: 0.09, output: 0.45 },
  "nemotron-3-ultra": { input: 0.5, output: 2.5 },

  // ── Qwen (openrouter.ai qwen provider) ────────────────────────────
  "qwen3-coder": { input: 0.22, output: 1.8 }, // 480B A35B
  "qwen3-coder-next": { input: 0.11, output: 0.8 },
  "qwen3-next:80b": { input: 0.09, output: 1.1 }, // 80B A3B
  "qwen3-vl:235b": { input: 0.2, output: 0.88 }, // VL 235B
  "qwen3-vl:235b-instruct": { input: 0.2, output: 0.88 },
  "qwen3.5": { input: 0.39, output: 2.34 }, // 397B A17B

  // ── Devstral (openrouter.ai mistralai) ──────────────────────────
  "devstral-2": { input: 0.4, output: 2.0 },
  "devstral-small-2": { input: 0.15, output: 0.6 },

  // ── Cogito (openrouter.ai deepcogito) ─────────────────────────────
  "cogito-2.1": { input: 1.25, output: 1.25 },

  // ── Other ────────────────────────────────────────────────────────────
  "rnj-1": { input: 0.15, output: 0.15 },
};

const DEFAULT_PRICE: ModelPrice = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Resolve estimated pricing for a model ID.
 * Checks exact match first, then base-ID match (strips `:tag` suffix),
 * then prefix-based fuzzy match.
 * Fills in cacheRead (10% of input) and cacheWrite (125% of input) defaults.
 */
function resolvePrice(modelId: string): ModelPrice {
  // Exact match
  const exact = MODEL_PRICING[modelId];
  if (exact) {
    return fillDefaults(exact);
  }

  // Base-ID match: strip `:tag` suffix (e.g. "deepseek-v3.1:671b" → "deepseek-v3.1")
  const colonIdx = modelId.indexOf(":");
  if (colonIdx > 0) {
    const baseId = modelId.substring(0, colonIdx);
    const baseMatch = MODEL_PRICING[baseId];
    if (baseMatch) {
      return fillDefaults(baseMatch);
    }
    // Try partial prefix match on baseId (require ≥3 chars to avoid false matches)
    for (const [key, price] of Object.entries(MODEL_PRICING)) {
      if (key.length >= 3 && baseId.length >= 3 && (baseId.startsWith(key) || key.startsWith(baseId))) {
        return fillDefaults(price);
      }
    }
  }

  // Prefix fuzzy match without colon (require ≥3 chars to avoid false matches)
  const baseIdNoCloud = modelId.replace(/:cloud$/, "");
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (
      key.length >= 3 &&
      baseIdNoCloud.length >= 3 &&
      (baseIdNoCloud.startsWith(key) || key.startsWith(baseIdNoCloud))
    ) {
      return fillDefaults(price);
    }
  }

  return { ...DEFAULT_PRICE };
}

/** Fill in cacheRead/cacheWrite defaults from input price ratios */
function fillDefaults(p: Partial<ModelPrice>): ModelPrice {
  const inp = p.input ?? 0;
  return {
    input: inp,
    output: p.output ?? 0,
    cacheRead: p.cacheRead ?? (inp ? +(inp * 0.1).toFixed(4) : 0),
    cacheWrite: p.cacheWrite ?? (inp ? +(inp * 1.25).toFixed(4) : 0),
  };
}

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

export const OLLAMA_BASE = (process.env.OLLAMA_API_BASE || "https://ollama.com").replace(/\/+$/, "");

// --- Raw API types ---
/** Response from POST /api/show */
interface OllamaShowResponse {
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
  model_info: Record<string, unknown>;
  capabilities: string[];
  modified_at: string;
}

type CachedOllamaModel = OllamaShowResponse;

/** On-disk cache: raw /api/show responses keyed by model ID. */
interface CachedData {
  /** Unix epoch milliseconds used to decide when the generated metadata is stale. */
  timestamp?: number;
  models: Record<string, CachedOllamaModel>;
}

type RefreshProgressStage = "list" | "details" | "done";

export interface RefreshProgress {
  stage: RefreshProgressStage;
  current?: number;
  total?: number;
  failed?: number;
  message: string;
}

// --- Assembly: raw API data -> ProviderModelConfig[] ---

/**
 * Build an explicit OpenAICompletionsCompat for an Ollama Cloud model.
 * Every flag is set explicitly so the contract is visible to maintainers.
 *
 * Ollama API reference: https://docs.ollama.com/api/openai-compatibility
 * pi type definition: https://github.com/earendil-works/pi/blob/b94482762321ed0b9f8f245be57c84d786a7105d/packages/ai/src/types.ts#L361-L400
 * pi compat resolution:  https://docs.ollama.com/api/openai-compatibility https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts#L365-L425
 */
function buildCompat(): ProviderModelConfig["compat"] {
  return {
    // Ollama uses "system" role, not "developer" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsDeveloperRole).
    supportsDeveloperRole: false,
    // reasoning_effort works (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsReasoningEffort, tested in think-experiment.md).
    supportsReasoningEffort: true,
    // "store" is not a supported field (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStore).
    supportsStore: false,
    // Ollama lists "max_tokens", not "max_completion_tokens" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#maxTokensField).
    maxTokensField: "max_tokens",
    // stream_options.include_usage is supported (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsUsageInStreaming).
    supportsUsageInStreaming: true,
    // Default: tool results don't need a name field (pi: types.ts#requiresToolResultName).
    requiresToolResultName: false,
    // Default: no assistant message required between tool result and user (pi: types.ts#requiresAssistantAfterToolResult).
    requiresAssistantAfterToolResult: false,
    // Ollama supports native thinking blocks (pi: types.ts#requiresThinkingAsText).
    requiresThinkingAsText: false,
    // DeepSeek-specific, not needed for Ollama (pi: types.ts#requiresReasoningContentOnAssistantMessages).
    requiresReasoningContentOnAssistantMessages: false,
    // reasoning_effort format works (pi: types.ts#thinkingFormat, tested in think-experiment.md).
    thinkingFormat: "openai",
    // Ollama does not support tool_choice, so strict mode is unavailable (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStrictMode).
    supportsStrictMode: false,
    // Anthropic cache_control not relevant; Ollama has implicit KV cache only (pi: types.ts#cacheControlFormat).
    // Explicitly undefined: JSON.stringify drops undefined values, keeping
    // models.generated.ts structurally consistent with assembleModels() runtime output.
    // Session affinity headers not relevant for Ollama (pi: types.ts#sendSessionAffinityHeaders).
    sendSessionAffinityHeaders: false,
    // No explicit cache-retention API (pi: types.ts#supportsLongCacheRetention).
    supportsLongCacheRetention: false,
    // Not z.ai (pi: types.ts#zaiToolStream).
    zaiToolStream: false,
    cacheControlFormat: undefined,
    openRouterRouting: {},
    vercelGatewayRouting: {},
  };
}

export function assembleModels(raw: Record<string, CachedOllamaModel>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => data.capabilities?.includes("tools"))
    .map(([id, data]) => ({
      id,
      name: id,
      reasoning: data.capabilities?.includes("thinking") ?? false,
      thinkingLevelMap: resolveThinkingLevelMap(id, data.capabilities ?? []),
      input: (data.capabilities?.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: resolvePrice(id),
      contextWindow: getContextLength(data.model_info ?? {}),
      // No per-model limit exposed by the API (https://docs.ollama.com/api-reference/show-model-details,
      // https://github.com/ollama/ollama/issues/7222). 32768 matches most Ollama Cloud context windows.
      maxTokens: 32768,
      compat: buildCompat(),
    }));
}

// --- Cache I/O ---
type CacheState =
  | { status: "fresh"; models: Record<string, CachedOllamaModel> }
  | { status: "stale"; models: Record<string, CachedOllamaModel> }
  | { status: "missing" };

function createCacheData(models: Record<string, CachedOllamaModel>, now = new Date()): CachedData {
  return { timestamp: now.getTime(), models };
}

function readCacheData(path: string): CachedData | null {
  try {
    const data: CachedData = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.models || Object.keys(data.models).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function isFreshGeneratedCache(data: CachedData): boolean {
  if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return false;
  return Date.now() - data.timestamp <= CACHE_MAX_AGE_MS;
}

export function readCacheState(): CacheState {
  if (!existsSync(CACHE_FILE)) return { status: "missing" };

  const data = readCacheData(CACHE_FILE);
  if (!data) {
    try {
      rmSync(CACHE_FILE, { force: true });
    } catch {
      // Ignore cache delete errors.
    }
    return { status: "missing" };
  }

  return isFreshGeneratedCache(data)
    ? { status: "fresh", models: data.models }
    : { status: "stale", models: data.models };
}

export function writeCache(models: Record<string, CachedOllamaModel>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(createCacheData(models), null, 2));
  } catch {
    // Ignore cache write errors
  }
}

// --- Fetch Models ---
export async function fetchModelIds(timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<{ data: { id: string }[] }>(
    `${OLLAMA_BASE}/v1/models`,
    { headers },
    timeoutMs,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data.data.map((m) => m.id);
}

export async function fetchModelDetails(id: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<CachedOllamaModel> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<OllamaShowResponse>(
    `${OLLAMA_BASE}/api/show`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: id }),
    },
    timeoutMs,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch /api/show for ${id}: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data;
}

export async function refreshOllamaCloudModels(params: {
  notify?: (message: string, level?: "info" | "error") => void;
  onProgress?: (progress: RefreshProgress) => void;
  workers?: number;
}): Promise<Record<string, CachedOllamaModel>> {
  const notify = params.notify ?? (() => undefined);
  const onProgress = params.onProgress ?? (() => undefined);
  onProgress({ stage: "list", message: "Fetching model list..." });
  const modelIds = await fetchModelIds();
  notify(`Found ${modelIds.length} models, fetching details...`);
  onProgress({
    stage: "details",
    current: 0,
    total: modelIds.length,
    failed: 0,
    message: "Fetching model details",
  });

  let detailsDone = 0;
  let detailsFailed = 0;
  const detailResults = await concurrentMap(modelIds, params.workers ?? 8, async (id) => {
    try {
      return [id, await fetchModelDetails(id)] as const;
    } catch (error) {
      detailsFailed++;
      throw error;
    } finally {
      detailsDone++;
      onProgress({
        stage: "details",
        current: detailsDone,
        total: modelIds.length,
        failed: detailsFailed,
        message: "Fetching model details",
      });
    }
  });
  const models: Record<string, CachedOllamaModel> = {};
  for (const result of detailResults) {
    if (result.status === "fulfilled") {
      const [id, data] = result.value;
      models[id] = data;
    }
  }
  const succeeded = Object.keys(models).length;
  if (succeeded === 0)
    throw new Error(`Failed to fetch model details${detailsFailed ? ` (${detailsFailed} failed)` : ""}`);
  notify(`Fetched ${succeeded} model details${detailsFailed ? ` (${detailsFailed} failed)` : ""}`, "info");

  onProgress({
    stage: "done",
    current: Object.keys(models).length,
    total: Object.keys(models).length,
    message: "Done",
  });
  return models;
}

export async function fetchModels(
  ctx: Pick<ExtensionCommandContext, "ui">,
  onProgress?: (progress: RefreshProgress) => void,
): Promise<Record<string, CachedOllamaModel> | null> {
  try {
    return await refreshOllamaCloudModels({
      notify: (message, level) => ctx.ui.notify(message, level),
      onProgress,
    });
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return null;
  }
}
