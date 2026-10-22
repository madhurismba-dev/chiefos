import fs from "node:fs";
import path from "node:path";

/**
 * Startup snapshot of an agent's folder: a short file tree the agent gets in its context, so it knows what's
 * there without spending turns on `ls`. Bounded in depth and size; skips dependency and VCS folders.
 */

const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", "out", ".venv", "__pycache__", ".DS_Store"]);
const MAX_DEPTH = 3;
const MAX_LINES = 120;

export function folderSnapshot(folder: string): string {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number, indent: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP.has(e.name)) {
        if (lines.length < MAX_LINES) lines.push(`${indent}${e.name}/ (skipped)`);
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        dirs++;
        if (lines.length < MAX_LINES) lines.push(`${indent}${e.name}/`);
        else truncated = true;
        if (depth < MAX_DEPTH) walk(full, depth + 1, `${indent}  `);
      } else {
        files++;
        let size = 0;
        try {
          size = fs.lstatSync(full).size;
        } catch {
          /* vanished */
        }
        bytes += size;
        const link = e.isSymbolicLink() ? " -> symlink" : "";
        if (lines.length < MAX_LINES) lines.push(`${indent}${e.name} (${formatBytes(size)})${link}`);
        else truncated = true;
      }
    }
  };
  walk(folder, 1, "");

  if (files === 0 && dirs === 0) return `${folder} is empty.`;
  const head = `${folder}: ${files} files in ${dirs} folders, ${formatBytes(bytes)} (top ${MAX_DEPTH} levels)`;
  return [head, ...lines, ...(truncated ? ["… (more not shown)"] : [])].join("\n");
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
