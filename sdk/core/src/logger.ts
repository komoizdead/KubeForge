export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function createLogger(name: string, level: LogLevel = "info"): Logger {
  const threshold = LOG_LEVELS[level];

  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LOG_LEVELS[entryLevel] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      logger: name,
      message,
      ...fields,
    });
    // stdout belongs to protocol data (the MCP server uses it for JSON-RPC).
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
