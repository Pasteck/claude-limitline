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
  // If we have a display name that's reasonable, use it
  if (displayName && displayName.length <= 20) {
    // Clean up display name
    const clean = displayName.replace(/^Claude\s*/i, "").trim();
    if (clean) return clean;
  }

  // Common model ID mappings
  const mappings: Record<string, string> = {
    "claude-opus-4-5-20251101": "Opus 4.5",
    "claude-opus-4-20250514": "Opus 4",
    "claude-sonnet-4-20250514": "Sonnet 4",
    "claude-3-5-sonnet-20241022": "Sonnet 3.5",
    "claude-3-5-sonnet-latest": "Sonnet 3.5",
    "claude-3-5-sonnet": "Sonnet 3.5",
    "claude-3-opus-20240229": "Opus 3",
    "claude-3-opus": "Opus 3",
    "claude-3-sonnet-20240229": "Sonnet 3",
    "claude-3-haiku-20240307": "Haiku 3",
    "claude-3-haiku": "Haiku 3",
  };

  // Check for exact match
  if (mappings[modelId]) {
    return mappings[modelId];
  }

  // Try to extract a friendly name from model ID
  const lower = modelId.toLowerCase();

  // Claude models
  if (lower.includes("opus")) {
    if (lower.includes("4-6") || lower.includes("4.6")) return "Opus 4.6";
    if (lower.includes("4-5") || lower.includes("4.5")) return "Opus 4.5";
    if (lower.includes("4")) return "Opus 4";
    if (lower.includes("3")) return "Opus 3";
    return "Opus";
  }
  if (lower.includes("sonnet")) {
    if (lower.includes("4-5") || lower.includes("4.5")) return "Sonnet 4.5";
    if (lower.includes("4")) return "Sonnet 4";
    if (lower.includes("3-5") || lower.includes("3.5")) return "Sonnet 3.5";
    if (lower.includes("3")) return "Sonnet 3";
    return "Sonnet";
  }
  if (lower.includes("haiku")) {
    if (lower.includes("3")) return "Haiku 3";
    return "Haiku";
  }

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
