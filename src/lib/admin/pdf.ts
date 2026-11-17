/**
 * A minimal PDF writer: one JPEG per A4 page (DCTDecode — PDF carries JPEG bytes as they are), for
 * documents the admin renders in the browser (the invoice sent on WhatsApp). No library: a catalog,
 * the page tree, an info dictionary with the title, and per page the image and a one-line content
 * stream that draws it over the whole page.
 */

export type PdfJpegPage = { jpeg: Uint8Array; width: number; height: number };

/** A4 in PDF points (1/72 inch). */
export const A4_POINTS = { width: 595.28, height: 841.89 } as const;

/** Text as a PDF string, UTF-16BE hex — any character, nothing to escape. */
function pdfText(text: string): string {
  let hex = "FEFF";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += code.toString(16).padStart(4, "0");
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/** "D:20261117093000Z" */
function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function jpegPagesToPdf(pages: readonly PdfJpegPage[], meta: { title?: string; author?: string } = {}): Uint8Array {
  if (pages.length === 0) throw new Error("A PDF needs at least one page.");
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const begin = (n: number) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };

  // Header + a binary comment (marks the file as binary for old tools).
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageObj = (i: number) => 4 + i * 3;
  const count = pages.length;
  begin(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  push(`<< /Type /Pages /Count ${count} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>\nendobj\n`);
  begin(3);
  push(
    `<< /Producer ${pdfText("Dock One Solutions admin")} /CreationDate (${pdfDate(new Date())})${meta.title ? ` /Title ${pdfText(meta.title)}` : ""}${meta.author ? ` /Author ${pdfText(meta.author)}` : ""} >>\nendobj\n`,
  );

  pages.forEach((page, i) => {
    const pageN = pageObj(i);
    const contentN = pageN + 1;
    const imageN = pageN + 2;
    const { width: w, height: h } = A4_POINTS;
    begin(pageN);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>\nendobj\n`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    begin(contentN);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(imageN);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
    push(page.jpeg);
    push("\nendstream\nendobj\n");
  });

  const size = 4 + count * 3;
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A canvas → JPEG bytes. */
export async function canvasJpeg(canvas: HTMLCanvasElement, quality = 0.9): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("The page couldn't be drawn.");
  return new Uint8Array(await blob.arrayBuffer());
}
