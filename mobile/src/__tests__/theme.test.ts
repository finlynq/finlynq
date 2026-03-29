import { lightColors, darkColors } from "../theme/colors";
import { spacing, borderRadius, fontSize } from "../theme";

describe("Theme", () => {
  describe("lightColors", () => {
    it("has all required color properties", () => {
      expect(lightColors.background).toBeDefined();
      expect(lightColors.foreground).toBeDefined();
      expect(lightColors.card).toBeDefined();
      expect(lightColors.primary).toBeDefined();
      expect(lightColors.secondary).toBeDefined();
      expect(lightColors.destructive).toBeDefined();
      expect(lightColors.border).toBeDefined();
      expect(lightColors.mutedForeground).toBeDefined();
    });

    it("has chart colors", () => {
      expect(lightColors.chart1).toBeDefined();
      expect(lightColors.chart2).toBeDefined();
      expect(lightColors.chart3).toBeDefined();
      expect(lightColors.chart4).toBeDefined();
      expect(lightColors.chart5).toBeDefined();
    });

    it("uses valid hex colors", () => {
      const hexRegex = /^#[0-9a-fA-F]{6}$/;
      Object.values(lightColors).forEach((color) => {
        expect(color).toMatch(hexRegex);
      });
    });
  });

  describe("darkColors", () => {
    it("has all required color properties", () => {
      expect(darkColors.background).toBeDefined();
      expect(darkColors.foreground).toBeDefined();
      expect(darkColors.card).toBeDefined();
      expect(darkColors.primary).toBeDefined();
      expect(darkColors.secondary).toBeDefined();
      expect(darkColors.destructive).toBeDefined();
      expect(darkColors.border).toBeDefined();
    });

    it("dark background is darker than light", () => {
      // Dark mode background should have lower hex values (darker)
      const darkBg = parseInt(darkColors.background.replace("#", ""), 16);
      const lightBg = parseInt(lightColors.background.replace("#", ""), 16);
      expect(darkBg).toBeLessThan(lightBg);
    });
  });

  describe("spacing", () => {
    it("has correct values", () => {
      expect(spacing.xs).toBe(4);
      expect(spacing.sm).toBe(8);
      expect(spacing.md).toBe(12);
      expect(spacing.lg).toBe(16);
      expect(spacing.xl).toBe(24);
      expect(spacing.xxl).toBe(32);
    });
  });

  describe("borderRadius", () => {
    it("has correct values", () => {
      expect(borderRadius.sm).toBe(7);
      expect(borderRadius.md).toBe(10);
      expect(borderRadius.lg).toBe(12);
      expect(borderRadius.xl).toBe(17);
      expect(borderRadius.full).toBe(9999);
    });
  });

  describe("fontSize", () => {
    it("has correct values", () => {
      expect(fontSize.xs).toBe(11);
      expect(fontSize.sm).toBe(13);
      expect(fontSize.base).toBe(15);
      expect(fontSize.lg).toBe(17);
      expect(fontSize.xl).toBe(20);
    });

    it("sizes increase monotonically", () => {
      const sizes = [fontSize.xs, fontSize.sm, fontSize.base, fontSize.lg, fontSize.xl];
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
      }
    });
  });
});
