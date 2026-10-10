import { describe, expect, it } from "vitest";
import { sniffReceiptFormat } from "../src/providers/receipt-format.js";

const pad = (head: number[]) => Uint8Array.from([...head, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("sniffReceiptFormat", () => {
  it.each([
    ["jpeg", pad([0xff, 0xd8, 0xff, 0xe0])],
    ["png", pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["webp", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])],
    ["pdf", pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])],
  ] as const)("detects %s", (format, data) => {
    expect(sniffReceiptFormat(data)).toBe(format);
  });

  it.each([
    ["gif", pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ["tiff", pad([0x49, 0x49, 0x2a, 0x00])],
    ["heic", Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
    ["docx/zip", pad([0x50, 0x4b, 0x03, 0x04])],
    ["empty", new Uint8Array(0)],
  ] as const)("rejects %s", (_name, data) => {
    expect(sniffReceiptFormat(data)).toBeNull();
  });

  it("finds a PDF header within the first 1024 bytes", () => {
    const data = new Uint8Array(1100);
    data.set([0x25, 0x50, 0x44, 0x46, 0x2d], 500);
    expect(sniffReceiptFormat(data)).toBe("pdf");
    const late = new Uint8Array(1100);
    late.set([0x25, 0x50, 0x44, 0x46, 0x2d], 1050);
    expect(sniffReceiptFormat(late)).toBeNull();
  });
});
