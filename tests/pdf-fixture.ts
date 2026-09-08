// Small text-only PDF used by Node and real Electron import regression tests.
export function textPDF(text: string) {
  const literal = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 12 Tf 50 700 Td (${literal}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

// An image-only PDF: there is intentionally no text layer for PDF.js to read.
export async function scannedPDF(lines: string[]) {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  // Explicitly load a bundled macOS CJK font; a Latin fallback would turn
  // Chinese text into empty boxes and would not be a valid OCR fixture.
  if (
    !GlobalFonts.registerFromPath(
      "/System/Library/Fonts/STHeiti Medium.ttc",
      "JobAgentOCRTest",
    )
  )
    throw new Error("OCR test fixture requires the macOS STHeiti font");
  const canvas = createCanvas(1200, 1600),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 1600);
  ctx.fillStyle = "black";
  ctx.font = "44px JobAgentOCRTest";
  lines.forEach((line, index) => ctx.fillText(line, 80, 160 + index * 90));
  const jpeg = canvas.toBuffer("image/jpeg");
  const commands = "q 600 0 0 800 0 0 cm /Im0 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(
      `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
    ),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")],
    offsets = [0];
  let length = chunks[0]!.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      objects[i]!,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
        .join(
          "",
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
