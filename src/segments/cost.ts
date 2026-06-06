import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { debug } from "../utils/logger.js";

// File-based cache for cost calculations
const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-limitline");
const COST_CACHE_FILE = path.join(CACHE_DIR, "cost-cache.json");

interface CostCacheData {
  cost: number;
  tokens: number;
  timeRange: CostTimeRange;
  model: string;  // Current model when cache was created
  timestamp: number;
  processedFiles: Record<string, { mtime: number; cost: number; tokens: number }>;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

function readCostCache(timeRange: CostTimeRange, model: string): CostCacheData | null {
  try {
    if (fs.existsSync(COST_CACHE_FILE)) {
      const content = fs.readFileSync(COST_CACHE_FILE, "utf-8");
      const caches = JSON.parse(content) as Record<string, CostCacheData>;
      const cacheKey = `${timeRange}:${model}`;
      return caches[cacheKey] || null;
    }
  } catch (error) {
    debug("Failed to read cost cache:", error);
  }
  return null;
}

function writeCostCache(timeRange: CostTimeRange, model: string, data: CostCacheData): void {
  try {
    ensureCacheDir();
    let caches: Record<string, CostCacheData> = {};
    if (fs.existsSync(COST_CACHE_FILE)) {
      try {
        caches = JSON.parse(fs.readFileSync(COST_CACHE_FILE, "utf-8"));
      } catch {
        // Ignore invalid cache
      }
    }
    const cacheKey = `${timeRange}:${model}`;
    caches[cacheKey] = data;
    fs.writeFileSync(COST_CACHE_FILE, JSON.stringify(caches), { mode: 0o600 });
  } catch (error) {
    debug("Failed to write cost cache:", error);
  }
}

// Model pricing per million tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // === Claude (Anthropic) ===
  // Opus 4.5 / 4.6 / 4.7
  "claude-opus-4-5-20251101": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Opus 4
  "claude-opus-4-20250514": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Sonnet 4 / 4.5
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Sonnet 3.5 v2
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Haiku 3.5
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // Haiku 3
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },

  // === Third-party models (CNY pricing) ===
  // SiliconFlow 的 cache 实际收费约为官方定价的 40%
  // 经验证: cache 价格 ≈ ¥0.59/M (官方 ¥1.5/M)
  // GLM (Z.AI / Zhipu) — SiliconFlow uses zai-org/ and Pro/ prefixes
  "pro/zai-org/glm-5": { input: 6, output: 22, cacheWrite: 6, cacheRead: 0.6 },
  "zhipu/glm-5": { input: 6, output: 22, cacheWrite: 6, cacheRead: 0.6 },           // alias
  "pro/zai-org/glm-4.7": { input: 6, output: 16, cacheWrite: 6, cacheRead: 0.6 },
  "zhipu/glm-4.7": { input: 6, output: 16, cacheWrite: 6, cacheRead: 0.6 },         // alias
  "zhipu/glm-4.7-flash": { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  "zai-org/glm-4.6": { input: 5, output: 14, cacheWrite: 5, cacheRead: 0.5 },
  "zhipu/glm-4.6": { input: 5, output: 14, cacheWrite: 5, cacheRead: 0.5 },         // alias
  // DeepSeek
  "deepseek-ai/deepseek-v3.2": { input: 2, output: 3, cacheWrite: 2, cacheRead: 0.2 },
  "deepseek-ai/deepseek-v3": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.2 },
  "deepseek-ai/deepseek-r1": { input: 4, output: 16, cacheWrite: 4, cacheRead: 0.4 },
  // Kimi (Moonshot)
  "moonshotai/kimi-k2.5": { input: 6, output: 22, cacheWrite: 6, cacheRead: 0.6 },
  "pro/moonshotai/kimi-k2.5": { input: 6, output: 22, cacheWrite: 6, cacheRead: 0.6 },   // alias
  "moonshotai/kimi-k2-instruct-0905": { input: 6, output: 16, cacheWrite: 6, cacheRead: 0.6 },
  // Qwen (Alibaba) — SiliconFlow
  "qwen/qwen3-coder-480b-a35b": { input: 8, output: 16, cacheWrite: 8, cacheRead: 0.8 },
  "qwen/qwen3-coder-30b-a3b": { input: 1, output: 3, cacheWrite: 1, cacheRead: 0.1 },
  // Qwen (Alibaba) — 阿里云百炼 (cache 价格待验证)
  "qwen3.5-plus": { input: 0.8, output: 4.8, cacheWrite: 0.8, cacheRead: 0.32 },

  // Default fallback (Sonnet pricing)
  "default": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export type CostTimeRange = "5h" | "7d" | "month" | "all";

export interface CostInfo {
  cost: number;
  tokens: number;
  timeRange: CostTimeRange;
  isEstimate: boolean;
  currency: "USD" | "CNY";
}

interface LogEntry {
  timestamp: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function getPricing(model: string) {
  // Strip [1m] suffix before lookup
  const cleaned = model.replace(/\[1m\]/gi, "");
  const lower = cleaned.toLowerCase();
  // Try exact match first (case-insensitive)
  if (MODEL_PRICING[lower]) {
    return MODEL_PRICING[lower];
  }
  if (MODEL_PRICING[cleaned]) {
    return MODEL_PRICING[cleaned];
  }
  // Try prefix match (case-insensitive)
  for (const key of Object.keys(MODEL_PRICING)) {
    if (lower.startsWith(key) || key.startsWith(lower)) {
      return MODEL_PRICING[key];
    }
  }
  // Default
  return MODEL_PRICING["default"];
}

function calculateEntryCost(entry: LogEntry): number {
  const usage = entry.message?.usage;
  if (!usage) return 0;

  const model = entry.message?.model || "default";
  const pricing = getPricing(model);

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  // Calculate cost (pricing is per million tokens)
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

// Get current model from environment
function getCurrentModel(): string {
  return process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
}

// Determine currency based on model/provider
function getModelCurrency(model: string): "USD" | "CNY" {
  const lower = model.replace(/\[1m\]/gi, "").toLowerCase();

  // Chinese providers/models use CNY
  const cnyPatterns = [
    /^pro\/zai-org\//,        // SiliconFlow Pro models (GLM-5, GLM-4.7)
    /^zai-org\//,             // Z.AI models (GLM-4.6)
    /^zhipu\//,               // Zhipu models
    /^deepseek-ai\//,         // DeepSeek
    /^moonshotai\//,          // Kimi
    /^qwen\//,                // Qwen models
    /qwen3\.5/,               // Qwen3.5 (Alibaba Cloud)
    /dashscope/,              // Alibaba Cloud
  ];

  for (const pattern of cnyPatterns) {
    if (pattern.test(lower)) {
      return "CNY";
    }
  }

  return "USD";
}

// Extract model family for grouping (e.g., "claude-opus-4-6" → "claude-opus")
// This ensures different versions of the same model are counted together
function getModelFamily(model: string): string {
  const lower = model.toLowerCase();

  // Strip [1m] and similar suffixes
  const cleaned = lower.replace(/\[1m\]/g, "");

  // Claude models: group by tier (opus, sonnet, haiku)
  const claudeMatch = cleaned.match(/^claude-(opus|sonnet|haiku)/);
  if (claudeMatch) return `claude-${claudeMatch[1]}`;

  // Third-party: strip vendor prefixes and version suffixes
  const stripped = cleaned.replace(/^(pro\/)?(zhipu|zai-org|deepseek-ai|moonshotai|qwen)\//i, "");

  // GLM family: glm-5, glm-4.7, glm-4.6 are separate products
  const glmMatch = stripped.match(/^glm-(\d+\.?\d*)/);
  if (glmMatch) return `glm-${glmMatch[1]}`;

  // DeepSeek: v3, v3.2, r1 are separate products
  const dsMatch = stripped.match(/^deepseek-(v\d+\.?\d*|r\d+)/);
  if (dsMatch) return `deepseek-${dsMatch[1]}`;

  // Qwen: qwen3.5-plus, qwen3-coder-480b etc. are separate
  const qwenMatch = stripped.match(/^(qwen\S+)/);
  if (qwenMatch) return qwenMatch[1];

  // Kimi
  const kimiMatch = stripped.match(/^(kimi-k\d+\.?\d*)/);
  if (kimiMatch) return kimiMatch[1];

  return cleaned;
}

// Check if entry matches current model (family-based matching)
function matchesModel(entryModel: string, currentModel: string): boolean {
  // When using official Claude (no CLAUDE_MODEL set), count ALL Claude models
  // This handles the common case where user is on subscription and uses opus/sonnet/haiku
  if (!process.env.CLAUDE_MODEL && !process.env.ANTHROPIC_MODEL) {
    return entryModel.toLowerCase().startsWith("claude-");
  }

  return getModelFamily(entryModel) === getModelFamily(currentModel);
}

export class CostProvider {
  private cacheDir: string;
  private readonly FILE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes file cache

  constructor() {
    this.cacheDir = path.join(os.homedir(), ".claude", "projects");
  }

  private getTimeRangeCutoff(timeRange: CostTimeRange): Date | null {
    const now = new Date();
    switch (timeRange) {
      case "5h":
        return new Date(now.getTime() - 5 * 60 * 60 * 1000);
      case "7d":
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case "month":
        return new Date(now.getFullYear(), now.getMonth(), 1);
      case "all":
        return null;  // No cutoff
    }
  }

  async getCostInfo(timeRange: CostTimeRange = "month"): Promise<CostInfo> {
    const now = Date.now();
    const currentModel = getCurrentModel();
    const currency = getModelCurrency(currentModel);

    // Try file cache first (cross-process sharing)
    const fileCache = readCostCache(timeRange, currentModel);
    if (fileCache && (now - fileCache.timestamp) < this.FILE_CACHE_TTL_MS) {
      debug(`Using file cached cost data (age: ${Math.round((now - fileCache.timestamp) / 1000)}s)`);
      return { cost: fileCache.cost, tokens: fileCache.tokens, timeRange, isEstimate: false, currency };
    }

    try {
      const costInfo = await this.calculateCostsIncremental(timeRange, currentModel, fileCache);
      return costInfo;
    } catch (error) {
      debug("Error calculating costs:", error);
      // Return stale cache if available
      if (fileCache) {
        return { cost: fileCache.cost, tokens: fileCache.tokens, timeRange, isEstimate: true, currency };
      }
      return { cost: 0, tokens: 0, timeRange, isEstimate: true, currency };
    }
  }

  private async calculateCostsIncremental(timeRange: CostTimeRange, currentModel: string, existingCache: CostCacheData | null): Promise<CostInfo> {
    const currency = getModelCurrency(currentModel);
    if (!fs.existsSync(this.cacheDir)) {
      debug("Claude projects directory not found");
      return { cost: 0, tokens: 0, timeRange, isEstimate: true, currency };
    }

    const cutoff = this.getTimeRangeCutoff(timeRange);

    // For time-bounded ranges (5h, month), invalidate cache when cutoff changes significantly
    // This prevents stale values when crossing time boundaries (e.g., new month)
    const shouldFullReprocess = existingCache && cutoff && this.cutoffChanged(existingCache, cutoff);

    let totalCost = shouldFullReprocess ? 0 : (existingCache?.cost || 0);
    let totalTokens = shouldFullReprocess ? 0 : (existingCache?.tokens || 0);
    const processedFiles: Record<string, { mtime: number; cost: number; tokens: number }> =
      shouldFullReprocess ? {} : { ...(existingCache?.processedFiles || {}) };

    // Find all JSONL files
    const jsonlFiles = this.findJsonlFiles(this.cacheDir);
    const currentFileSet = new Set(jsonlFiles);
    debug(`Found ${jsonlFiles.length} JSONL files`);

    // Remove deleted files from cache
    for (const cachedFile of Object.keys(processedFiles)) {
      if (!currentFileSet.has(cachedFile)) {
        totalCost -= processedFiles[cachedFile].cost;
        totalTokens -= processedFiles[cachedFile].tokens;
        delete processedFiles[cachedFile];
        debug(`Removed deleted file from cache: ${cachedFile}`);
      }
    }

    let filesProcessed = 0;
    let filesSkipped = 0;

    for (const file of jsonlFiles) {
      try {
        const stat = fs.statSync(file);
        const mtime = stat.mtimeMs;
        const cached = processedFiles[file];

        // Skip if file hasn't changed since last processing
        if (cached && cached.mtime === mtime) {
          filesSkipped++;
          continue;
        }

        // If file was previously processed but changed, subtract old values
        if (cached) {
          totalCost -= cached.cost;
          totalTokens -= cached.tokens;
        }

        // Process the file
        const { cost, tokens } = this.processFile(file, cutoff, currentModel);
        totalCost += cost;
        totalTokens += tokens;
        processedFiles[file] = { mtime, cost, tokens };
        filesProcessed++;

      } catch (error) {
        debug(`Error processing file ${file}:`, error);
      }
    }

    // Ensure no negative drift from floating point
    if (totalCost < 0) totalCost = 0;
    if (totalTokens < 0) totalTokens = 0;

    debug(`Cost (${timeRange}, ${currentModel}): $${totalCost.toFixed(2)}, Tokens: ${totalTokens} (processed: ${filesProcessed}, skipped: ${filesSkipped})`);

    // Save to file cache
    writeCostCache(timeRange, currentModel, {
      cost: totalCost,
      tokens: totalTokens,
      timeRange,
      model: currentModel,
      timestamp: Date.now(),
      processedFiles,
    });

    return { cost: totalCost, tokens: totalTokens, timeRange, isEstimate: false, currency };
  }

  private cutoffChanged(cache: CostCacheData, currentCutoff: Date): boolean {
    // If cache was created before the current cutoff, the time window has shifted
    // and cached per-file values may include entries outside the new window
    return cache.timestamp < currentCutoff.getTime();
  }

  private processFile(file: string, cutoff: Date | null, currentModel: string): { cost: number; tokens: number } {
    let cost = 0;
    let tokens = 0;

    try {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());

      // Deduplicate by requestId: keep only the last entry per API call
      // Claude Code writes multiple JSONL entries per streaming response,
      // each with the SAME input/cache tokens but growing output tokens.
      // We must only count each request once.
      const requestEntries = new Map<string, LogEntry>();

      for (const line of lines) {
        try {
          const raw = JSON.parse(line);
          if (!raw.message?.usage) continue;

          const entryModel = raw.message?.model;
          if (!entryModel || !matchesModel(entryModel, currentModel)) continue;

          if (cutoff && raw.timestamp) {
            const entryTime = new Date(raw.timestamp);
            if (entryTime < cutoff) continue;
          }

          const reqId = raw.requestId;
          if (reqId) {
            // Keep last entry per request (has the final output_tokens)
            requestEntries.set(reqId, raw as LogEntry);
          } else {
            // No requestId — count directly (legacy format)
            cost += calculateEntryCost(raw as LogEntry);
            const usage = raw.message!.usage!;
            tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) +
                      (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // Process deduplicated entries
      for (const entry of requestEntries.values()) {
        cost += calculateEntryCost(entry);
        const usage = entry.message!.usage!;
        tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      }
    } catch (error) {
      debug(`Error reading file ${file}:`, error);
    }

    return { cost, tokens };
  }

  private findJsonlFiles(dir: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          files.push(...this.findJsonlFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      debug(`Error reading directory ${dir}:`, error);
    }

    return files;
  }
}
