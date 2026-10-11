import { describe, expect, it } from "vitest";
import { parseCoordinates } from "../src/lib/locations";

describe("parseCoordinates", () => {
  it("reads what Google Maps copies", () => {
    expect(parseCoordinates("47.9184, 106.9177")).toEqual({ lat: 47.9184, lng: 106.9177 });
    expect(parseCoordinates(" 47.9184 106.9177 ")).toEqual({ lat: 47.9184, lng: 106.9177 });
  });
  it("refuses text and out-of-range values", () => {
    expect(parseCoordinates("Ulaanbaatar")).toBeNull();
    expect(parseCoordinates("147.9, 106.9")).toBeNull();
    expect(parseCoordinates("47.9")).toBeNull();
  });
});
