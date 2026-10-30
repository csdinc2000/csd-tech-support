// Decode a base64 photo upload and verify it really is a JPEG / PNG / WebP by
// its magic bytes — the client-declared mime type is never trusted.
export function decodeImageUpload(
  dataBase64: string,
  maxBytes: number,
): { buffer: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" } {
  const raw = dataBase64.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) throw new Error("A photo could not be read");
  if (buffer.length > maxBytes) {
    throw new Error(`Each photo must be under ${Number((maxBytes / 1_000_000).toFixed(1))} MB`);
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { buffer, mimeType: "image/jpeg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { buffer, mimeType: "image/png" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { buffer, mimeType: "image/webp" };
  }
  throw new Error("Photos must be JPEG, PNG or WebP");
}
