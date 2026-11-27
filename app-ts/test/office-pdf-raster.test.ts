import { describe, expect, it } from "vitest";

import { encodePngRgba } from "../src/services/office-render/pdf-raster.js";

describe("encodePngRgba (npm-only raster output)", () => {
  it("writes a valid PNG signature and IHDR dimensions", () => {
    const pixels = new Uint8Array(4 * 2 * 2);
    pixels.fill(255);
    const png = encodePngRgba(pixels, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = Buffer.from(png);
    expect(view.toString("ascii", 12, 16)).toBe("IHDR");
    expect(view.readUInt32BE(16)).toBe(2);
    expect(view.readUInt32BE(20)).toBe(2);
    expect(view.toString("ascii", png.length - 8, png.length - 4)).toBe("IEND");
  });

  it("rejects invalid sizes and insufficient pixel data", () => {
    expect(() => encodePngRgba(new Uint8Array(4), 0, 1)).toThrow();
    expect(() => encodePngRgba(new Uint8Array(4), 2, 2)).toThrow();
  });
});
