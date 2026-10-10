export type ReceiptFormat = "jpeg" | "png" | "webp" | "pdf";

export const RECEIPT_MIME_BY_FORMAT: Readonly<Record<ReceiptFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

function hasBytesAt(data: Uint8Array, signature: readonly number[], offset: number): boolean {
  return (
    data.length >= offset + signature.length &&
    signature.every((byte, index) => data[offset + index] === byte)
  );
}

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"

export function sniffReceiptFormat(data: Uint8Array): ReceiptFormat | null {
  if (hasBytesAt(data, [0xff, 0xd8, 0xff], 0)) return "jpeg";
  if (hasBytesAt(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) return "png";
  if (hasBytesAt(data, [0x52, 0x49, 0x46, 0x46], 0) && hasBytesAt(data, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  const scanEnd = Math.min(1024, data.length - PDF_SIGNATURE.length);
  for (let offset = 0; offset <= scanEnd; offset += 1) {
    if (hasBytesAt(data, PDF_SIGNATURE, offset)) return "pdf";
  }
  return null;
}
