import { debug } from "./logger.js";

/**
 * Hook data passed by Claude Code via stdin
 */
export interface ClaudeHookData {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: {
    id: string;
    display_name: string;
  };
  workspace?: {
    current_dir: string;
    project_dir: string;
  };
  context_window?: {
    current_usage: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    context_window_size: number;
  };
  version?: string;
}

/**
 * Read hook data from stdin (non-blocking with timeout)
 */
export async function readHookData(): Promise<ClaudeHookData | null> {
  // If stdin is a TTY (interactive terminal), no hook data
  if (process.stdin.isTTY) {
    debug("stdin is TTY, no hook data");
    return null;
  }

  try {
    const chunks: Buffer[] = [];

    // Read with a short timeout
    const result = await Promise.race([
      new Promise<string>((resolve, reject) => {
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        process.stdin.on("error", reject);
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    if (!result || result.trim() === "") {
      debug("No stdin data received");
      return null;
    }

    const hookData = JSON.parse(result) as ClaudeHookData;
    debug("Hook data received:", JSON.stringify(hookData));
    return hookData;
  } catch (error) {
    debug("Error reading hook data:", error);
    return null;
  }
}

/**
 * Format model name for compact display
 */
export function formatModelName(modelId: string, displayName?: string): string {
  // Strip the "[1m]" / "[1M]" 1M-context variant suffix before parsing. 1M
  // context is the default now, so we don't surface it as a separate marker —
  // we only remove it so it can't interfere with version detection.
  const lower = modelId.replace(/\[1m\]/gi, "").toLowerCase();

  // --- Claude models -------------------------------------------------------
  // Parse the version GENERICALLY from the ID so new releases (4.8, 4.9, 5.x …)
  // never require a code change. The ID is the canonical source — always present
  // and unambiguous — so we check it before the human-facing display name.
  //
  // Modern ID order:  claude-<family>-<major>[-.<minor>][-<date>]
  // The (?!\d) guard stops an 8-digit date (e.g. "-20250514") from being read
  // as a 2-digit minor version.
  let m = lower.match(/claude-(opus|sonnet|haiku)-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?/);
  if (m) {
    const family = m[1][0].toUpperCase() + m[1].slice(1);
    const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `${family} ${version}`;
  }
  // Legacy ID order:  claude-<major>[-.<minor>]-<family>  (e.g. claude-3-5-sonnet)
  m = lower.match(/claude-(\d{1,2})(?:[-.](\d{1,2}))?-(opus|sonnet|haiku)/);
  if (m) {
    const family = m[3][0].toUpperCase() + m[3].slice(1);
    const version = m[2] ? `${m[1]}.${m[2]}` : m[1];
    return `${family} ${version}`;
  }

  // --- Human display name from Claude Code (non-Claude / unusual IDs) -------
  // Used only when the ID could not be parsed above. Drop the "Claude " prefix
  // and any trailing parenthetical (e.g. "(1M context)") instead of rejecting
  // the whole name on an arbitrary length cutoff.
  if (displayName) {
    const clean = displayName
      .replace(/^Claude\s*/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (clean && clean.length <= 24) return clean;
  }

  // --- Bare Claude family (version could not be parsed) --------------------
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";

  // Third-party models (SiliconFlow / direct API format)
  if (lower.includes("glm")) {
    const glmMatch = modelId.match(/GLM[-_]?([\d.]+)/i);
    const ver = glmMatch ? glmMatch[1] : "";
    const suffix = lower.includes("code") ? " Code" : lower.includes("flash") ? "F" : "";
    return `GLM-${ver}${suffix}` || "GLM";
  }
  if (lower.includes("deepseek")) {
    const dsMatch = modelId.match(/[Dd]eep[Ss]eek[-_]?(V[\d.]+|R[\d.]+)/i);
    if (dsMatch) return `DS ${dsMatch[1].toUpperCase()}`;
    return "DeepSeek";
  }
  if (lower.includes("kimi")) {
    const kimiMatch = modelId.match(/[Kk]imi[-_]?[Kk]([\d.]+)/);
    return kimiMatch ? `Kimi K${kimiMatch[1]}` : "Kimi";
  }
  if (lower.includes("qwen")) {
    // Qwen3.5-Plus etc. (Alibaba Cloud Bailian)
    if (lower.includes("qwen3.5")) {
      const suffix = lower.includes("plus") ? "+" : lower.includes("max") ? " Max" : "";
      return `Qwen3.5${suffix}`;
    }
    // Qwen3-Coder etc. (SiliconFlow)
    if (lower.includes("coder")) {
      const verMatch = modelId.match(/[Qq]wen([\d.]+)/);
      const sizeMatch = modelId.match(/(\d+)[Bb]/);
      const ver = verMatch ? verMatch[1] : "";
      const size = sizeMatch ? sizeMatch[1] + "B" : "";
      return `Qwen${ver} ${size || "Coder"}`.trim();
    }
    // Generic Qwen
    const verMatch = modelId.match(/[Qq]wen([\d.]+)/);
    return verMatch ? `Qwen${verMatch[1]}` : "Qwen";
  }

  // Strip common vendor prefixes for unknown models
  const stripped = modelId.replace(/^(Pro\/)?(zhipu|zai-org|deepseek-ai|moonshotai|Qwen)\//i, "");
  return stripped.length > 15 ? stripped.slice(0, 13) + ".." : stripped;
}

/**
 * Model-specific context window overrides (in tokens)
 * Used when API doesn't return accurate context_window_size
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Qwen3.5-Plus (Alibaba Cloud Bailian/DashScope) - 1M tokens
  "qwen3.5-plus": 1048576,
  "Qwen3.5+": 1048576,
};

/**
 * Get context window size for a model, with fallbacks
 */
export function getModelContextWindow(modelId: string, apiContextSize?: number | null): number {
  // First check our overrides
  const lower = modelId.toLowerCase();
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key.toLowerCase())) {
      return size;
    }
  }

  // Fall back to API-provided value
  if (apiContextSize && apiContextSize > 0) {
    return apiContextSize;
  }

  // Default fallback
  return 200000; // 200K default
}
