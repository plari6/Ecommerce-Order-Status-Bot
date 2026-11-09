const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Logs go to stderr so `--json` output on stdout stays machine-readable. */
export function createLogger(level = process.env.LOG_LEVEL || 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl) => (...args) => {
    if (LEVELS[lvl] < min) return;
    process.stderr.write(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
