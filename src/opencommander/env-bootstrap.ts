/**
 * Imported right after ./bootstrap.js by every entry point, before the
 * upstream server module is evaluated.
 *  - upstream Desktop Commander telemetry OFF unless config.telemetry = true
 */
import { getConfig } from './config.js';

try {
    if (!getConfig().telemetry && !process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY) {
        process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    }
} catch {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
}
