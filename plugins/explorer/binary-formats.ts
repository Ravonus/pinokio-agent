import zlib from 'node:zlib';

export const MAX_ZIP_SOURCE_BYTES: number = 512 * 1024 * 1024;

export const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface DosDateTime {
  dosTime: number;
  dosDate: number;
}

export function toDosDateTime(date: Date | null): DosDateTime {
  const dt = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, dt.getFullYear()));
  const month = dt.getMonth() + 1;
  const day = dt.getDate();
  const hour = dt.getHours();
  const minute = dt.getMinutes();
  const second = Math.floor(dt.getSeconds() / 2);
  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

export function createSingleFileZipBuffer(entryName: string, content: Buffer, modifiedAt: Date): Buffer {
  const fileNameBuffer = Buffer.from(entryName.replace(/\\/g, '/'), 'utf8');
  const compressed = zlib.deflateRawSync(content, { level: 9 });
  const crc = crc32(content);
  const { dosTime, dosDate } = toDosDateTime(modifiedAt);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralDirectory = Buffer.concat([centralHeader, fileNameBuffer]);
  const localSection = Buffer.concat([localHeader, fileNameBuffer, compressed]);

  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(0, 4);
  endOfCentral.writeUInt16LE(0, 6);
  endOfCentral.writeUInt16LE(1, 8);
  endOfCentral.writeUInt16LE(1, 10);
  endOfCentral.writeUInt32LE(centralDirectory.length, 12);
  endOfCentral.writeUInt32LE(localSection.length, 16);
  endOfCentral.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDirectory, endOfCentral]);
}

export function escapePdfText(value: unknown): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '');
}

export function createPdfBufferFromText(text: string): Buffer {
  const lines = String(text || '')
    .split(/\r?\n/)
    .slice(0, 200)
    .map((line) => escapePdfText(line));
  const nonEmpty = lines.length > 0 ? lines : [''];
  const ops: string[] = ['BT', '/F1 12 Tf', '50 780 Td'];
  for (let i = 0; i < nonEmpty.length; i += 1) {
    ops.push(`(${nonEmpty[i]}) Tj`);
    if (i < nonEmpty.length - 1) {
      ops.push('0 -16 Td');
    }
  }
  ops.push('ET');
  const streamData = `${ops.join('\n')}\n`;
  const streamLength = Buffer.byteLength(streamData, 'utf8');

  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    5: `<< /Length ${streamLength} >>\nstream\n${streamData}endstream`
  };

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'utf8')];
  const offsets: number[] = [0];
  let cursor = chunks[0].length;

  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = cursor;
    const objectChunk = Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`, 'utf8');
    chunks.push(objectChunk);
    cursor += objectChunk.length;
  }

  const xrefOffset = cursor;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'utf8'));

  return Buffer.concat(chunks);
}
