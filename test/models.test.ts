import { describe, expect, it } from "vitest";
import { assembleModels } from "../models.ts";
import { resolve } from "../thinking-levels.ts";
import { getContextLength } from "../utils.ts";

// --- Helpers ---


/** Minimal valid /api/show response matching the real Ollama Cloud API shape. */
function rawModel(overrides: {
  capabilities?: string[];
  modelInfo?: Record<string, unknown>;
  details?: Partial<{
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  }>;
} = {}) {
  return {
    details: {
      parent_model: "",
      format: "",
      family: "test",
      families: null,
      parameter_size: "7000000000",
      quantization_level: "Q4_K_M",
      ...overrides.details,
    },
    model_info: overrides.modelInfo ?? {},
    // Real API always includes "completion"; we omit it since
    // assembleModels only checks for "tools", "thinking", and "vision".
    capabilities: overrides.capabilities ?? ["tools"],
    modified_at: new Date().toISOString(),
  };
}

// ============================================================================
// assembleModels
// ============================================================================

describe("assembleModels", () => {
  it("filters out models without tools capability", () => {
    const raw = {
      "no-tools": rawModel({ capabilities: ["thinking"] }),
      "has-tools": rawModel(),
    };
    const models = assembleModels(raw);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("has-tools");
  });

  it("sets id and name from the model key", () => {
    const raw = { "glm-5.1": rawModel() };
    const models = assembleModels(raw);
    expect(models[0].id).toBe("glm-5.1");
    expect(models[0].name).toBe("glm-5.1");
  });

  it("defaults reasoning to false when thinking capability is absent", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].reasoning).toBe(false);
    expect(models[0].thinkingLevelMap).toBeUndefined();
  });

  it("sets reasoning to true and assigns DEFAULT map when thinking is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "thinking"] }) });
    expect(models[0].reasoning).toBe(true);
    expect(models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("defaults input to text-only", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].input).toEqual(["text"]);
  });

  it("adds image to input when vision capability is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "vision"] }) });
    expect(models[0].input).toEqual(["text", "image"]);
  });

  it("sets all compat flags explicitly on every model", () => {
    const models = assembleModels({ m: rawModel() });
    const compat = models[0].compat;

    // Tested against the live API (think-experiment.md, docs/openai.md):
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsReasoningEffort).toBe(true);
    expect(compat?.thinkingFormat).toBe("openai");

    // Verified against docs/openai.md:
    // "store" is not listed, Ollama lists "max_tokens" not "max_completion_tokens",
    // stream_options.include_usage is supported, tool_choice is not supported.
    expect(compat?.supportsStore).toBe(false);
    expect(compat?.maxTokensField).toBe("max_tokens");
    expect(compat?.supportsUsageInStreaming).toBe(true);
    expect(compat?.supportsStrictMode).toBe(false);

    // Verified against docs/anthropic.md: prompt caching is "Not supported".
    expect(compat?.cacheControlFormat).toBeUndefined();

    // Standard OpenAI-compatible defaults:
    expect(compat?.requiresToolResultName).toBe(false);
    expect(compat?.requiresAssistantAfterToolResult).toBe(false);
    expect(compat?.requiresThinkingAsText).toBe(false);
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(false);
    expect(compat?.sendSessionAffinityHeaders).toBe(false);
    expect(compat?.supportsLongCacheRetention).toBe(false);
    expect(compat?.zaiToolStream).toBe(false);
    expect(compat?.openRouterRouting).toEqual({});
    expect(compat?.vercelGatewayRouting).toEqual({});
  });

  it("sets all costs to zero (subscription model, not per-token billing)", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("extracts contextWindow from model_info using .context_length suffix", () => {
    const models = assembleModels({
      m: rawModel({ modelInfo: { "test.context_length": 262144 } }),
    });
    expect(models[0].contextWindow).toBe(262144);
  });

  it("falls back to 128000 when context_length is missing from model_info", () => {
    // Default from getContextLength(), documented in README table.
    const models = assembleModels({ m: rawModel() });
    expect(models[0].contextWindow).toBe(128000);
  });

  it("sets maxTokens to 32768 (no per-model limit exposed by API)", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].maxTokens).toBe(32768);
  });

  describe("thinking level maps", () => {
    it("assigns GPT_OSS map to gpt-oss models", () => {
      const models = assembleModels({
        "gpt-oss:20b": rawModel({ capabilities: ["tools", "thinking"] }),
        "gpt-oss:120b": rawModel({ capabilities: ["tools", "thinking"] }),
      });
      for (const m of models) {
        expect(m.thinkingLevelMap).toEqual({
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
        });
      }
    });

    it("assigns QWEN3 (binary think/nothink) to qwen3 non-VL models", () => {
      const models = assembleModels({
        "qwen3:397b": rawModel({ capabilities: ["tools", "thinking"] }),
        "qwen3-next:80b": rawModel({ capabilities: ["tools", "thinking"] }),
      });
      for (const m of models) {
        expect(m.thinkingLevelMap).toEqual({
          off: "none",
          minimal: null,
          low: null,
          medium: "medium",
          high: null,
          xhigh: null,
        });
      }
    });

    it("assigns NO_OFF to qwen3-vl models (none does not disable thinking)", () => {
      const models = assembleModels({ "qwen3-vl:235b": rawModel({ capabilities: ["tools", "thinking", "vision"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
      });
    });

    it("assigns NO_OFF to kimi-k2-thinking (none does not disable thinking)", () => {
      const models = assembleModels({ "kimi-k2-thinking": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
      });
    });

    it("assigns NO_OFF to minimax models (none does not disable thinking)", () => {
      const models = assembleModels({ "minimax-m2.7": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
      });
    });
  });
});

// ============================================================================
// resolve (thinking level maps)
// ============================================================================

describe("resolve", () => {
  it("returns undefined for models without thinking capability", () => {
    expect(resolve("any-model", [])).toBeUndefined();
    expect(resolve("any-model", ["tools"])).toBeUndefined();
    expect(resolve("any-model", ["tools", "vision"])).toBeUndefined();
  });

  it("returns DEFAULT for unrecognized thinking models", () => {
    expect(resolve("unknown-model", ["tools", "thinking"])).toEqual({
      off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
    });
  });

  it("returns GPT_OSS for gpt-oss prefix", () => {
    expect(resolve("gpt-oss:20b", ["tools", "thinking"])).toEqual({
      off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null,
    });
    expect(resolve("gpt-oss:120b", ["tools", "thinking"])).toEqual({
      off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null,
    });
  });

  it("returns QWEN3 for qwen3 models (except qwen3-vl)", () => {
    expect(resolve("qwen3:397b", ["tools", "thinking"])).toEqual({
      off: "none", minimal: null, low: null, medium: "medium", high: null, xhigh: null,
    });
    expect(resolve("qwen3-next:80b", ["tools", "thinking"])).toEqual({
      off: "none", minimal: null, low: null, medium: "medium", high: null, xhigh: null,
    });
  });

  it("returns NO_OFF for qwen3-vl prefix (none does not disable thinking)", () => {
    expect(resolve("qwen3-vl:235b", ["tools", "thinking", "vision"])).toEqual({
      off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
    });
  });

  it("returns NO_OFF for kimi-k2-thinking (exact match only)", () => {
    expect(resolve("kimi-k2-thinking", ["tools", "thinking"])).toEqual({
      off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
    });
    // kimi-k2.5 and kimi-k2.6 support "none" correctly — DEFAULT, not NO_OFF
    expect(resolve("kimi-k2.5", ["tools", "thinking"])).toEqual({
      off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
    });
    expect(resolve("kimi-k2.6", ["tools", "thinking"])).toEqual({
      off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
    });
  });

  it("returns NO_OFF for minimax prefix", () => {
    for (const id of ["minimax-m2.1", "minimax-m2.5", "minimax-m2.7"]) {
      expect(resolve(id, ["tools", "thinking"])).toEqual({
        off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max",
      });
    }
  });

  it("returns undefined when thinking is absent regardless of prefix", () => {
    expect(resolve("gpt-oss:20b", ["tools"])).toBeUndefined();
    expect(resolve("qwen3:397b", ["tools"])).toBeUndefined();
    expect(resolve("minimax-m2.7", ["tools"])).toBeUndefined();
  });
});

// ============================================================================
// getContextLength
// ============================================================================

describe("getContextLength", () => {
  it("extracts context length from any key ending in .context_length", () => {
    expect(getContextLength({ "test.context_length": 262144 })).toBe(262144);
    expect(getContextLength({ "some-prefix.context_length": 128000 })).toBe(128000);
  });

  it("returns first match when multiple context_length keys exist", () => {
    expect(getContextLength({
      "a.context_length": 100000,
      "b.context_length": 200000,
    })).toBe(100000);
  });

  it("falls back to 128000 when no context_length key exists", () => {
    expect(getContextLength({})).toBe(128000);
    expect(getContextLength({ some_other_key: 42 })).toBe(128000);
  });

  it("ignores context_length values that are not numbers", () => {
    expect(getContextLength({ "test.context_length": "not-a-number" })).toBe(128000);
  });
});
