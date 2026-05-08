/**
 * @file logger.ts
 * @description Winston logger with pretty (dev) and JSON (prod) modes.
 * Honours LOG_LEVEL and LOG_FORMAT env vars. Default: info / pretty.
 */
import winston from 'winston';

const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const format = (process.env.LOG_FORMAT ?? 'pretty').toLowerCase();

const prettyFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: false }),
  winston.format.printf((info) => {
    const { timestamp, level: lvl, message, ...rest } = info as Record<string, unknown> & {
      timestamp: string;
      level: string;
      message: string;
    };
    const restKeys = Object.keys(rest).filter((k) => !k.startsWith('Symbol('));
    const meta = restKeys.length ? ' ' + JSON.stringify(rest) : '';
    return `${timestamp} ${lvl.padEnd(5)} ${message}${meta}`;
  }),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level,
  format: format === 'json' ? jsonFormat : prettyFormat,
  transports: [new winston.transports.Console()],
});

/**
 * Build a child logger that attaches a stable `component` field to every line.
 * Helps grep through fleet logs (component=battery-sim, component=vpp-cloud, ...).
 */
export function child(component: string): winston.Logger {
  return logger.child({ component });
}
