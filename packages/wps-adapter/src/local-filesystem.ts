export interface WpsFileSystemApi {
  Exists?: (path: string) => boolean;
  existsSync?: (path: string) => boolean;
  Mkdir?: (path: string) => unknown;
  mkdirSync?: (path: string, options?: { recursive?: boolean }) => unknown;
  mkdtempSync?: (prefix: string) => string;
  /** Official WPS JSAPI read method. */
  ReadFile?: (path: string) => string;
  /** Some WPS builds expose the write method although it is not in old typings. */
  WriteFile?: (path: string, value: string) => unknown;
  writeFileString?: (path: string, value: string) => unknown;
  WriteFileString?: (path: string, value: string) => unknown;
  readFileString?: (path: string) => string;
  ReadFileString?: (path: string) => string;
  unlinkSync?: (path: string) => unknown;
  rmdirSync?: (path: string) => unknown;
  Remove?: (path: string) => unknown;
  AppendFile?: (path: string, value: string) => unknown;
}

/** Normalize mixed separators before crossing the WPS FileSystem boundary. */
export function normalizeWpsPath(path: string): string {
  const value = String(path).replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(value)) return value.slice(0, 3) + value.slice(3).replace(/\\{2,}/g, "\\");
  if (value.startsWith("\\\\")) return "\\\\" + value.slice(2).replace(/\\{2,}/g, "\\");
  return value.replace(/\\{2,}/g, "\\");
}

function parentDirectories(path: string): string[] {
  const normalized = path.replaceAll("/", "\\");
  const prefix = normalized.match(/^[a-zA-Z]:\\/)?.[0] ?? "";
  const withoutPrefix = prefix ? normalized.slice(prefix.length) : normalized;
  const parts = withoutPrefix.split("\\").filter(Boolean);
  const values: string[] = [];
  let current = prefix || "";
  for (const part of parts) {
    current = current ? current.replace(/[\\]+$/, "") + "\\" + part : part;
    values.push(current);
  }
  return values;
}

export class WpsLocalFileSystem {
  constructor(private readonly api: WpsFileSystemApi) {}

  exists(path: string): boolean {
    const normalized = normalizeWpsPath(path);
    if (typeof this.api.Exists === "function") return Boolean(this.api.Exists.call(this.api, normalized));
    if (typeof this.api.existsSync === "function") return Boolean(this.api.existsSync.call(this.api, normalized));
    throw new Error("WPS_FILESYSTEM_EXISTS_UNAVAILABLE");
  }

  mkdir(path: string): void {
    const normalized = normalizeWpsPath(path);
    if (typeof this.api.mkdirSync === "function") {
      this.api.mkdirSync.call(this.api, normalized, { recursive: true });
      return;
    }
    if (typeof this.api.Mkdir === "function") {
      for (const directory of parentDirectories(normalized)) {
        try {
          this.api.Mkdir.call(this.api, directory);
        } catch {
          /* WPS Mkdir may reject existing parents; recursive creation is best-effort. */
        }
      }
      return;
    }
    throw new Error("WPS_FILESYSTEM_MKDIR_UNAVAILABLE");
  }

  writeText(path: string, value: string): void {
    const normalized = normalizeWpsPath(path);
    const write = this.api.WriteFile ?? this.api.writeFileString ?? this.api.WriteFileString;
    if (typeof write !== "function") throw new Error("WPS_FILESYSTEM_WRITE_UNAVAILABLE");
    write.call(this.api, normalized, value);
  }

  readText(path: string): string {
    const normalized = normalizeWpsPath(path);
    // ReadFile is the official WPS JSAPI. ReadFileString variants are kept
    // only for older compatibility hosts and must never take precedence.
    const read = this.api.ReadFile ?? this.api.readFileString ?? this.api.ReadFileString;
    if (typeof read !== "function") throw new Error("WPS_FILESYSTEM_READ_UNAVAILABLE");
    return String(read.call(this.api, normalized));
  }

  removeFile(path: string): void {
    const normalized = normalizeWpsPath(path);
    if (typeof this.api.unlinkSync === "function") {
      try {
        this.api.unlinkSync.call(this.api, normalized);
      } catch {
        return;
      }
      return;
    }
    if (typeof this.api.Remove === "function") {
      try {
        this.api.Remove.call(this.api, normalized);
      } catch {
        return;
      }
      return;
    }
    throw new Error("WPS_FILESYSTEM_REMOVE_UNAVAILABLE");
  }

  removeDirectory(path: string): void {
    const normalized = normalizeWpsPath(path);
    if (typeof this.api.rmdirSync === "function") {
      try {
        this.api.rmdirSync.call(this.api, normalized);
      } catch {
        return;
      }
      return;
    }
    if (typeof this.api.Remove === "function") {
      try {
        this.api.Remove.call(this.api, normalized);
      } catch {
        return;
      }
      return;
    }
    throw new Error("WPS_FILESYSTEM_RMDIR_UNAVAILABLE");
  }

  appendText(path: string, value: string): void {
    const normalized = normalizeWpsPath(path);
    // Official AppendFile(path) only creates/opens the file; it has no data
    // argument in the WPS JSAPI contract. Use a two-argument compatibility
    // implementation only when the host explicitly exposes one.
    if (typeof this.api.AppendFile === "function" && this.api.AppendFile.length >= 2) {
      this.api.AppendFile.call(this.api, normalized, value);
      return;
    }
    const current = this.exists(normalized) ? this.readText(normalized) : "";
    this.writeText(normalized, current + value);
  }
}
