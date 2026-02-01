#!/usr/bin/env node
/**
 * Background cache refresh script
 * Run this via cron to keep the usage cache fresh
 * statusLine will only read from cache, never block on API calls
 */

import { getOAuthToken, fetchUsageFromAPI } from "./utils/oauth.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-limitline");
const USAGE_CACHE_FILE = path.join(CACHE_DIR, "usage-cache.json");
const LOCK_FILE = path.join(CACHE_DIR, "refresh.lock");

function log(msg: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

function acquireLock(): boolean {
  try {
    ensureCacheDir();
    // Check if lock exists and is recent (< 60 seconds)
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age < 60000) {
        log("Another refresh is in progress, skipping");
        return false;
      }
      // Stale lock, remove it
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { mode: 0o600 });
    return true;
  } catch (error) {
    log(`Failed to acquire lock: ${error}`);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (error) {
    log(`Failed to release lock: ${error}`);
  }
}

interface FileCacheData {
  data: unknown;
  timestamp: number;
  previousData?: unknown;
}

function readExistingCache(): FileCacheData | null {
  try {
    if (fs.existsSync(USAGE_CACHE_FILE)) {
      const content = fs.readFileSync(USAGE_CACHE_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    log(`Failed to read existing cache: ${error}`);
  }
  return null;
}

function writeCache(data: unknown, previousData?: unknown): void {
  try {
    ensureCacheDir();
    const cacheData: FileCacheData = {
      data,
      timestamp: Date.now(),
      previousData,
    };
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cacheData, null, 2), { mode: 0o600 });
    log("Cache updated successfully");
  } catch (error) {
    log(`Failed to write cache: ${error}`);
  }
}

async function main(): Promise<void> {
  log("Starting cache refresh...");

  if (!acquireLock()) {
    process.exit(0);
  }

  try {
    // Get OAuth token
    const token = await getOAuthToken();
    if (!token) {
      log("ERROR: Could not retrieve OAuth token");
      process.exit(1);
    }
    log("OAuth token retrieved");

    // Fetch usage from API
    const usage = await fetchUsageFromAPI(token);
    if (!usage) {
      log("ERROR: Failed to fetch usage from API");
      process.exit(1);
    }
    log(`Usage fetched: 5h=${usage.fiveHour?.percentUsed?.toFixed(1)}%, 7d=${usage.sevenDay?.percentUsed?.toFixed(1)}%`);

    // Read existing cache for trend tracking
    const existingCache = readExistingCache();
    const previousData = existingCache?.data;

    // Write new cache
    writeCache(usage, previousData);

    log("Cache refresh completed");
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  log(`Unhandled error: ${error}`);
  releaseLock();
  process.exit(1);
});
