interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

// PDF drawing order is not reading order. Group nearby baselines, then read
// each line from left to right; distant date columns stay on the title line.
export function orderedPDFText(items: unknown[]): string {
  const chunks = items
    .filter((item): item is TextItem => {
      const t = item as TextItem;
      return (
        typeof t.str === "string" &&
        !!t.str.trim() &&
        Array.isArray(t.transform) &&
        t.transform.length === 6
      );
    })
    .sort(
      (a, b) =>
        b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!,
    );
  const lines: { y: number; height: number; items: TextItem[] }[] = [];
  for (const item of chunks) {
    const y = item.transform[5]!;
    const last = lines.at(-1);
    if (
      last &&
      Math.abs(last.y - y) <=
        Math.max(2, Math.min(last.height, item.height) * 0.45)
    )
      last.items.push(item);
    else lines.push({ y, height: item.height, items: [item] });
  }
  return lines
    .map((line) => {
      let right = -Infinity,
        result = "";
      for (const item of line.items.sort(
        (a, b) => a.transform[4]! - b.transform[4]!,
      )) {
        const gap = item.transform[4]! - right;
        if (
          result &&
          gap > Math.max(1, item.height * 0.15) &&
          !result.endsWith(" ")
        )
          result += gap > item.height * 2 ? "  " : " ";
        result += item.str;
        right = Math.max(right, item.transform[4]! + item.width);
      }
      return result.trim();
    })
    .join("\n");
}
