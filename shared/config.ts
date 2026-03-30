import fs from "fs";
import path from "path";

export interface PfConfig {
  dbPath: string;
  mode: "local" | "cloud";
  salt: string; // hex-encoded
}

const DEFAULT_CONFIG: PfConfig = {
  dbPath: "./pf.db",
  mode: "local",
  salt: "",
};

function getDataDir(): string {
  // PF_DATA_DIR overrides cwd — needed because Next.js standalone mode
  // calls process.chdir() to .next/standalone/, moving cwd away from the
  // project root where user data files live.
  return process.env.PF_DATA_DIR || process.cwd();
}

function getConfigPath(): string {
  return path.join(getDataDir(), "pf-config.json");
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

export function readConfig(): PfConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function writeConfig(config: PfConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function resolveDbPath(config: PfConfig): string {
  if (path.isAbsolute(config.dbPath)) {
    return config.dbPath;
  }
  return path.join(getDataDir(), config.dbPath);
}
