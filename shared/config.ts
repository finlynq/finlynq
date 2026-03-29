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

function getConfigPath(): string {
  // Config lives next to the app root
  return path.join(process.cwd(), "pf-config.json");
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
  return path.join(process.cwd(), config.dbPath);
}
