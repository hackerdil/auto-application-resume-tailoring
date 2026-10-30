import { ValidationError } from "@career-agent/domain";

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxTotalUncompressed: 50 * 1024 * 1024,
  maxRatio: 100,
};

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Reads the ZIP central directory without decompressing anything and rejects archive bombs, ZIP64,
 * encrypted entries, and unsafe entry names before a parser ever sees the file.
 */
export function inspectZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntryInfo[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ValidationError("ZIP64 archives are not supported.");
  if (count > limits.maxEntries)
    throw new ValidationError(`Archive has too many entries (${count}).`);
  if (cdOffset + cdSize > buf.length) throw new ValidationError("Corrupt archive.");

  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new ValidationError("Corrupt archive.");
    const flags = buf.readUInt16LE(p + 8);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw new ValidationError("Encrypted archives are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new ValidationError("ZIP64 archives are not supported.");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
      throw new ValidationError("Archive contains an unsafe entry name.");
    }
    if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > limits.maxRatio) {
      throw new ValidationError("Archive compression ratio is suspicious (possible zip bomb).");
    }
    total += uncompressedSize;
    if (total > limits.maxTotalUncompressed)
      throw new ValidationError("Archive expands beyond the allowed size (possible zip bomb).");
    entries.push({ name, compressedSize, uncompressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ValidationError("Not a ZIP archive.");
}
