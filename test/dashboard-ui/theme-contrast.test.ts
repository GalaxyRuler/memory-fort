import { describe, expect, test } from "vitest";

import tailwindConfig from "../../tailwind.config";

const themeColors = tailwindConfig.theme.extend.colors;

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`Expected 6-digit hex color, got ${hex}`);

  const value = match[1];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);

  return (
    0.2126 * channelToLinear(red) +
    0.7152 * channelToLinear(green) +
    0.0722 * channelToLinear(blue)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("dashboard theme contrast", () => {
  test("text-muted meets AA contrast on dark dashboard surfaces while remaining below secondary text", () => {
    const muted = themeColors["text-muted"];
    const secondary = themeColors["text-secondary"];
    const darkSurfaces = [
      themeColors.background,
      themeColors.surface,
      themeColors["surface-2"],
      "#1e222a",
      themeColors["surface-3"],
    ];

    for (const surface of darkSurfaces) {
      expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrastRatio(muted, themeColors.background)).toBeLessThan(
      contrastRatio(secondary, themeColors.background),
    );
  });
});
