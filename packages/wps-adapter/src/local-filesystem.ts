export interface WpsFileSystemApi {
  Exists?: (path: string) => boolean;
  existsSync?: (path: string) => boolean;
  Mkdir?: (path: string) => unknown;
  mkdirSync?: (path: string, options?: { recursive?: boolean }) => unknown;
  mkdtempSync?: (prefix: string) => string;
  writeFileString?: (path: string, value: string) => unknown;
  WriteFileString?: (path: string, value: string) => unknown;
  readFileString?: (path: string) => string;
  ReadFileString?: (path: string) => string;
  unlinkSync?: (path: string) => unknown;
  rmdirSync?: (path: string) => unknown;
  Remove?: (path: string) => unknown;
  AppendFile?: (path: string, value: string) => unknown;
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
    if (typeof this.api.Exists === "function") return Boolean(this.api.Exists.call(this.api, path));
    if (typeof this.api.existsSync === "function") return Boolean(this.api.existsSync.call(this.api, path));
    throw new Error("WPS_FILESYSTEM_EXISTS_UNAVAILABLE");
  }

  mkdir(path: string): void {
    if (typeof this.api.mkdirSync === "function") {
      this.api.mkdirSync.call(this.api, path, { recursive: true });
      return;
    }
    if (typeof this.api.Mkdir === "function") {
      for (const directory of parentDirectories(path)) {
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
    const write = this.api.writeFileString ?? this.api.WriteFileString;
    if (typeof write !== "function") throw new Error("WPS_FILESYSTEM_WRITE_UNAVAILABLE");
    write.call(this.api, path, value);
  }

  readText(path: string): string {
    const read = this.api.readFileString ?? this.api.ReadFileString;
    if (typeof read !== "function") throw new Error("WPS_FILESYSTEM_READ_UNAVAILABLE");
    return String(read.call(this.api, path));
  }

  removeFile(path: string): void {
    if (typeof this.api.unlinkSync === "function") {
      try {
        this.api.unlinkSync.call(this.api, path);
      } catch {
        return;
      }
      return;
    }
    if (typeof this.api.Remove === "function") {
      try {
        this.api.Remove.call(this.api, path);
      } catch {
        return;
      }
      return;
    }
    throw new Error("WPS_FILESYSTEM_REMOVE_UNAVAILABLE");
  }

  removeDirectory(path: string): void {
    if (typeof this.api.rmdirSync === "function") {
      try {
        this.api.rmdirSync.call(this.api, path);
      } catch {
        return;
      }
      return;
    }
    if (typeof this.api.Remove === "function") {
      try {
        this.api.Remove.call(this.api, path);
      } catch {
        return;
      }
      return;
    }
    throw new Error("WPS_FILESYSTEM_RMDIR_UNAVAILABLE");
  }

  appendText(path: string, value: string): void {
    if (typeof this.api.AppendFile === "function") {
      this.api.AppendFile.call(this.api, path, value);
      return;
    }
    const current = this.exists(path) ? this.readText(path) : "";
    this.writeText(path, current + value);
  }
}
