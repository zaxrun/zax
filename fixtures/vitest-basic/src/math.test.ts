import { describe, it, expect } from "vitest";

describe("Math", () => {
  describe("add", () => {
    it("adds two positive numbers", () => {
      expect(1 + 2).toBe(3);
    });

    it("handles zero", () => {
      expect(0 + 5).toBe(5);
    });

    it("intentionally fails", () => {
      // This test intentionally fails to verify failure detection
      expect(2 + 2).toBe(5);
    });
  });

  describe("multiply", () => {
    it("multiplies positive numbers", () => {
      expect(2 * 3).toBe(6);
    });
  });
});
