import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { debug } from "../utils/logger.js";

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

export interface CostInfo {
  totalCost: number;
  sessionCost: number;  // Current 5-hour session
  totalTokens: number;
  sessionTokens: number;  // Current 5-hour session
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
  private cachedCost: CostInfo | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute cache

  constructor() {
    this.cacheDir = path.join(os.homedir(), ".claude", "projects");
  }

  async getCostInfo(): Promise<CostInfo> {
    const now = Date.now();

    // Return cached if fresh
    if (this.cachedCost && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return this.cachedCost;
    }

    try {
      const costInfo = await this.calculateCosts();
      this.cachedCost = costInfo;
      this.cacheTimestamp = now;
      return costInfo;
    } catch (error) {
      debug("Error calculating costs:", error);
      return { totalCost: 0, sessionCost: 0, totalTokens: 0, sessionTokens: 0, isEstimate: true };
    }
  }

  private async calculateCosts(): Promise<CostInfo> {
    if (!fs.existsSync(this.cacheDir)) {
      debug("Claude projects directory not found");
      return { totalCost: 0, sessionCost: 0, totalTokens: 0, sessionTokens: 0, isEstimate: true };
    }

    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    let totalCost = 0;
    let sessionCost = 0;
    let totalTokens = 0;
    let sessionTokens = 0;

    // Find all JSONL files
    const jsonlFiles = this.findJsonlFiles(this.cacheDir);
    debug(`Found ${jsonlFiles.length} JSONL files`);

    for (const file of jsonlFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n").filter(line => line.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as LogEntry;

            // Skip non-message entries
            if (!entry.message?.usage) continue;

            const cost = calculateEntryCost(entry);
            const usage = entry.message!.usage!;
            const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) +
                          (usage.cache_creation_input_tokens || 0);

            totalCost += cost;
            totalTokens += tokens;

            // Check if within current session (5 hours)
            if (entry.timestamp) {
              const entryTime = new Date(entry.timestamp);
              if (entryTime >= fiveHoursAgo) {
                sessionCost += cost;
                sessionTokens += tokens;
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      } catch (error) {
        debug(`Error reading file ${file}:`, error);
      }
    }

    debug(`Total cost: $${totalCost.toFixed(2)}, Session cost: $${sessionCost.toFixed(2)}, Total tokens: ${totalTokens}, Session tokens: ${sessionTokens}`);
    return { totalCost, sessionCost, totalTokens, sessionTokens, isEstimate: false };
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
