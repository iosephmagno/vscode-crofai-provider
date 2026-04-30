import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.crofai-logs');

export function logPayloadToFile(type: 'request' | 'response', payload: unknown) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(LOG_DIR, `${type}-${timestamp}.txt`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    // Ignore logging errors
  }
}
