import { describe, it, expect } from "vitest";

describe("Utils", () => {
  describe("String operations", () => {
    describe("trim", () => {
      it("removes leading whitespace", () => {
        expect("  hello".trim()).toBe("hello");
      });

      it("removes trailing whitespace", () => {
        expect("hello  ".trim()).toBe("hello");
      });
    });
  });

  describe("Array operations", () => {
    it("finds array length", () => {
      expect([1, 2, 3].length).toBe(3);
    });

    it("nested failure test", () => {
      // Another intentional failure for delta testing
      expect([1, 2].length).toBe(10);
    });
  });
});
