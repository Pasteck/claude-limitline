import { describe, it, expect } from "vitest";
import { formatModelName } from "./claude-hook.js";

describe("formatModelName", () => {
  describe("exact model ID mappings", () => {
    it("formats claude-opus-4-5-20251101 as Opus 4.5", () => {
      expect(formatModelName("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    });

    it("formats claude-opus-4-20250514 as Opus 4", () => {
      expect(formatModelName("claude-opus-4-20250514")).toBe("Opus 4");
    });

    it("formats claude-sonnet-4-20250514 as Sonnet 4", () => {
      expect(formatModelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    });

    it("formats claude-3-5-sonnet-20241022 as Sonnet 3.5", () => {
      expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    });

    it("formats claude-3-5-sonnet-latest as Sonnet 3.5", () => {
      expect(formatModelName("claude-3-5-sonnet-latest")).toBe("Sonnet 3.5");
    });

    it("formats claude-3-opus-20240229 as Opus 3", () => {
      expect(formatModelName("claude-3-opus-20240229")).toBe("Opus 3");
    });

    it("formats claude-3-haiku-20240307 as Haiku 3", () => {
      expect(formatModelName("claude-3-haiku-20240307")).toBe("Haiku 3");
    });
  });

  describe("pattern-based extraction", () => {
    it("extracts Opus 4.5 from unknown model IDs with opus and 4-5", () => {
      expect(formatModelName("claude-opus-4-5-custom")).toBe("Opus 4.5");
    });

    it("extracts Opus 4.5 from model IDs with opus and 4.5", () => {
      expect(formatModelName("claude-opus-4.5-test")).toBe("Opus 4.5");
    });

    it("extracts Opus 4 from model IDs with opus and 4", () => {
      expect(formatModelName("claude-opus-4-test")).toBe("Opus 4");
    });

    it("extracts Sonnet 4 from model IDs with sonnet and 4", () => {
      expect(formatModelName("claude-sonnet-4-custom")).toBe("Sonnet 4");
    });

    it("extracts Sonnet 3.5 from model IDs with sonnet and 3-5", () => {
      expect(formatModelName("claude-3-5-sonnet-custom")).toBe("Sonnet 3.5");
    });

    it("extracts Haiku from model IDs containing haiku", () => {
      expect(formatModelName("claude-haiku-unknown")).toBe("Haiku");
    });

    it("returns generic Opus for opus without version", () => {
      expect(formatModelName("opus-model")).toBe("Opus");
    });

    it("returns generic Sonnet for sonnet without version", () => {
      expect(formatModelName("sonnet-model")).toBe("Sonnet");
    });
  });

  describe("display name handling", () => {
    it("uses display name when provided and short", () => {
      expect(formatModelName("claude-opus-4-5-20251101", "Claude Opus 4.5")).toBe("Opus 4.5");
    });

    it("strips Claude prefix from display name", () => {
      expect(formatModelName("model-id", "Claude Sonnet")).toBe("Sonnet");
    });

    it("falls back to model ID for long display names", () => {
      const longDisplayName = "This is a very long display name that exceeds twenty chars";
      expect(formatModelName("claude-opus-4-5-20251101", longDisplayName)).toBe("Opus 4.5");
    });

    it("falls back to model ID when display name becomes empty after cleaning", () => {
      expect(formatModelName("claude-opus-4-5-20251101", "Claude")).toBe("Opus 4.5");
    });
  });

  describe("unknown model IDs", () => {
    it("truncates unknown long model IDs to 15 chars", () => {
      const longId = "unknown-model-id-that-is-very-long";
      expect(formatModelName(longId).length).toBeLessThanOrEqual(15);
    });

    it("returns short unknown model IDs as-is", () => {
      expect(formatModelName("short-model")).toBe("short-model");
    });
  });

  // Regression: the version used to be matched against a hardcoded ladder
  // (4-5, 4-6, 4-7 …), so every new release silently fell back to "Opus 4"
  // until someone patched the list. These lock in generic version parsing.
  describe("version parsing is future-proof (no hardcoded ladder)", () => {
    it("formats claude-opus-4-8 as Opus 4.8", () => {
      expect(formatModelName("claude-opus-4-8")).toBe("Opus 4.8");
    });

    it("formats claude-opus-4-7 as Opus 4.7", () => {
      expect(formatModelName("claude-opus-4-7")).toBe("Opus 4.7");
    });

    it("formats claude-sonnet-4-6 as Sonnet 4.6", () => {
      expect(formatModelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    });

    it("formats a hypothetical future claude-opus-5-2 as Opus 5.2", () => {
      expect(formatModelName("claude-opus-5-2")).toBe("Opus 5.2");
    });

    it("formats a hypothetical future claude-sonnet-5 as Sonnet 5", () => {
      expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5");
    });

    it("does not mistake an 8-digit date for a minor version", () => {
      expect(formatModelName("claude-opus-4-20250514")).toBe("Opus 4");
    });
  });

  describe("1M context variant", () => {
    it("strips the [1m] suffix without surfacing a 1M marker", () => {
      expect(formatModelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    });

    it("strips [1m] before parsing the version", () => {
      expect(formatModelName("claude-sonnet-4-5[1m]")).toBe("Sonnet 4.5");
    });

    it("ID parsing wins over a verbose display name", () => {
      expect(formatModelName("claude-opus-4-8[1m]", "Opus 4.8 (1M context)")).toBe("Opus 4.8");
    });

    it("drops a trailing (1M context) from a display name", () => {
      expect(formatModelName("model-id", "Opus 4.8 (1M context)")).toBe("Opus 4.8");
    });
  });
});
