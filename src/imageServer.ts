import * as crypto from 'crypto';
import { logInfo, logWarn, logError, logDebug } from './logger.js';

const UPLOAD_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const MAX_IMAGES = 50;

function logImageInfo(msg: string, ...args: unknown[]): void {
  logInfo(`[ImageServer] ${msg}`, ...args);
}
function logImageWarn(msg: string, ...args: unknown[]): void {
  logWarn(`[ImageServer] ${msg}`, ...args);
}
function logImageError(msg: string, ...args: unknown[]): void {
  logError(`[ImageServer] ${msg}`, ...args);
}
function logImageDebug(msg: string, ...args: unknown[]): void {
  logDebug(`[ImageServer] ${msg}`, ...args);
}

export class RemoteImageServer {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly cache = new Map<string, string>();

  async upload(data: Buffer, mimeType: string): Promise<string> {
    const key = crypto.createHash('sha256').update(data).digest('hex');
    logImageDebug(`upload() called mimeType=${mimeType} dataSize=${data.length} sha256=${key.substring(0, 16)}...`);

    // Check cache
    const existing = this.cache.get(key);
    if (existing) {
      logImageInfo(`Cache HIT for ${key.substring(0, 16)}... returning ${existing}`);
      return existing;
    }

    // Check in-flight pending
    if (this.pending.has(key)) {
      logImageInfo(`Pending HIT for ${key.substring(0, 16)}... waiting for in-flight upload`);
      return this.pending.get(key)!;
    }

    logImageInfo(`Starting upload mimeType=${mimeType} dataSize=${data.length}`);

    const promise = this._doUpload(data, mimeType).then((url) => {
      this.cache.set(key, url);
      this.pending.delete(key);
      if (this.cache.size > MAX_IMAGES) {
        const first = this.cache.keys().next().value;
        if (first) this.cache.delete(first);
        logImageDebug(`Cache evicted, size now=${this.cache.size}`);
      }
      logImageInfo(`Upload SUCCESS key=${key.substring(0, 16)}... url=${url}`);
      return url;
    }).catch((err) => {
      this.pending.delete(key);
      logImageError(`Upload FAILED key=${key.substring(0, 16)}... error=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });

    this.pending.set(key, promise);
    return promise;
  }

  private async _doUpload(data: Buffer, mimeType: string): Promise<string> {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg';
    const boundary = `----CrofAI${crypto.randomUUID().replace(/-/g, '')}`;
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="time"\r\n\r\n1h\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="image.${ext}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      data,
      Buffer.from(footer, 'utf-8'),
    ]);

    logImageInfo(`_doUpload: POST to Litterbox bodySize=${body.length} ext=${ext}`);
    const uploadStart = Date.now();
    const response = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const uploadDuration = Date.now() - uploadStart;
    logImageInfo(`_doUpload: Litterbox responded status=${response.status} duration=${uploadDuration}ms`);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logImageError(`_doUpload: Litterbox HTTP ${response.status} body=${text.substring(0, 300)}`);
      throw new Error(`Litterbox upload failed (${response.status}): ${text}`);
    }

    const url = (await response.text()).trim();
    logImageDebug(`_doUpload: Raw response text: "${url.substring(0, 100)}"`);
    if (!url || !url.startsWith('http')) {
      logImageError(`_doUpload: Invalid URL returned: "${url}"`);
      throw new Error(`Litterbox returned invalid URL: ${url}`);
    }
    logImageInfo(`_doUpload: SUCCESS url=${url}`);
    return url;
  }

  async start(): Promise<string> {
    return 'https://litterbox.catbox.moe';
  }

  dispose(): void {
    this.cache.clear();
    this.pending.clear();
  }
}

export const imageServer = new RemoteImageServer();
