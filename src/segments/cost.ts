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
  timestamp: number;
  processedFiles: Record<string, { mtime: number; cost: number; tokens: number }>;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

function readCostCache(timeRange: CostTimeRange): CostCacheData | null {
  try {
    if (fs.existsSync(COST_CACHE_FILE)) {
      const content = fs.readFileSync(COST_CACHE_FILE, "utf-8");
      const caches = JSON.parse(content) as Record<string, CostCacheData>;
      return caches[timeRange] || null;
    }
  } catch (error) {
    debug("Failed to read cost cache:", error);
  }
  return null;
}

function writeCostCache(timeRange: CostTimeRange, data: CostCacheData): void {
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
    caches[timeRange] = data;
    fs.writeFileSync(COST_CACHE_FILE, JSON.stringify(caches), { mode: 0o600 });
  } catch (error) {
    debug("Failed to write cost cache:", error);
  }
}

// Model pricing per million tokens (as of 2025)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // Opus 4.5
  "claude-opus-4-5-20251101": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Opus 4
  "claude-opus-4-20250514": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Sonnet 4
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
  // Default fallback (Sonnet pricing)
  "default": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export type CostTimeRange = "5h" | "7d" | "month" | "all";

export interface CostInfo {
  cost: number;
  tokens: number;
  timeRange: CostTimeRange;
  isEstimate: boolean;
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
  // Try exact match first
  if (MODEL_PRICING[model]) {
    return MODEL_PRICING[model];
  }
  // Try prefix match
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) {
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

    // Try file cache first (cross-process sharing)
    const fileCache = readCostCache(timeRange);
    if (fileCache && (now - fileCache.timestamp) < this.FILE_CACHE_TTL_MS) {
      debug(`Using file cached cost data (age: ${Math.round((now - fileCache.timestamp) / 1000)}s)`);
      return { cost: fileCache.cost, tokens: fileCache.tokens, timeRange, isEstimate: false };
    }

    try {
      const costInfo = await this.calculateCostsIncremental(timeRange, fileCache);
      return costInfo;
    } catch (error) {
      debug("Error calculating costs:", error);
      // Return stale cache if available
      if (fileCache) {
        return { cost: fileCache.cost, tokens: fileCache.tokens, timeRange, isEstimate: true };
      }
      return { cost: 0, tokens: 0, timeRange, isEstimate: true };
    }
  }

  private async calculateCostsIncremental(timeRange: CostTimeRange, existingCache: CostCacheData | null): Promise<CostInfo> {
    if (!fs.existsSync(this.cacheDir)) {
      debug("Claude projects directory not found");
      return { cost: 0, tokens: 0, timeRange, isEstimate: true };
    }

    const cutoff = this.getTimeRangeCutoff(timeRange);
    let totalCost = existingCache?.cost || 0;
    let totalTokens = existingCache?.tokens || 0;
    const processedFiles: Record<string, { mtime: number; cost: number; tokens: number }> =
      existingCache?.processedFiles || {};

    // Find all JSONL files
    const jsonlFiles = this.findJsonlFiles(this.cacheDir);
    debug(`Found ${jsonlFiles.length} JSONL files`);

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
        const { cost, tokens } = this.processFile(file, cutoff);
        totalCost += cost;
        totalTokens += tokens;
        processedFiles[file] = { mtime, cost, tokens };
        filesProcessed++;

      } catch (error) {
        debug(`Error processing file ${file}:`, error);
      }
    }

    debug(`Cost (${timeRange}): $${totalCost.toFixed(2)}, Tokens: ${totalTokens} (processed: ${filesProcessed}, skipped: ${filesSkipped})`);

    // Save to file cache
    writeCostCache(timeRange, {
      cost: totalCost,
      tokens: totalTokens,
      timeRange,
      timestamp: Date.now(),
      processedFiles,
    });

    return { cost: totalCost, tokens: totalTokens, timeRange, isEstimate: false };
  }

  private processFile(file: string, cutoff: Date | null): { cost: number; tokens: number } {
    let cost = 0;
    let tokens = 0;

    try {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;

          // Skip non-message entries
          if (!entry.message?.usage) continue;

          // Check if within time range
          if (cutoff && entry.timestamp) {
            const entryTime = new Date(entry.timestamp);
            if (entryTime < cutoff) continue;
          }

          cost += calculateEntryCost(entry);
          const usage = entry.message!.usage!;
          tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) +
                    (usage.cache_creation_input_tokens || 0);
        } catch {
          // Skip invalid JSON lines
        }
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
