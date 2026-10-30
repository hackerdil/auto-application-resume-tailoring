import { realpathSync } from "node:fs";
import path from "node:path";
import { PolicyError } from "@career-agent/domain";

/**
 * Resolves `relative` inside `root` and refuses anything that escapes it (path traversal, absolute paths,
 * NUL bytes). When the target or its parent exists, symlinks are resolved and re-checked.
 */
export function resolveInside(root: string, relative: string): string {
  if (relative.includes("\0")) throw new PolicyError("Invalid path.");
  if (path.isAbsolute(relative)) throw new PolicyError("Absolute paths are not allowed.");
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);
  assertWithin(rootAbs, target);

  const realRoot = tryRealpath(rootAbs) ?? rootAbs;
  const realTarget =
    tryRealpath(target) ??
    (() => {
      const parent = tryRealpath(path.dirname(target));
      return parent ? path.join(parent, path.basename(target)) : null;
    })();
  if (realTarget) assertWithin(realRoot, realTarget);
  return target;
}

function assertWithin(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PolicyError("Path escapes its allowed directory.");
  }
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

const SAFE_EXTENSIONS = new Set(["pdf", "docx", "html", "txt", "json", "png", "jpg", "jpeg"]);

/** Content-addressed storage name; never derived from user-supplied file names. */
export function artifactStorageName(sha256: string, extension: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new PolicyError("Invalid artifact hash.");
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (!SAFE_EXTENSIONS.has(ext)) throw new PolicyError(`Extension .${ext} is not allowed.`);
  return `${sha256.slice(0, 2)}/${sha256}.${ext}`;
}
