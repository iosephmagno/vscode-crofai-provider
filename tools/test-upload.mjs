// Simulate exactly what the extension does when uploading an image to Litterbox
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testImage = process.argv[2] || '/Users/iosemagno/Downloads/test.png';

async function upload(data, mimeType) {
  const boundary = `----CrofAI${crypto.randomUUID().replace(/-/g, '')}`;
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg';
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

  console.log(`Uploading ${data.length} bytes as ${mimeType}...`);

  const response = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const url = (await response.text()).trim();
  console.log(`Upload success! URL: ${url}`);
  return url;
}

async function main() {
  if (!fs.existsSync(testImage)) {
    console.error(`File not found: ${testImage}`);
    process.exit(1);
  }

  const data = fs.readFileSync(testImage);
  const ext = path.extname(testImage).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

  try {
    const url = await upload(data, mimeType);
    console.log('\n=== TEST PASSED ===');
    console.log(`The URL "${url}" is a valid public URL that CrofAI API can reach.`);

    // Verify the URL is reachable
    const check = await fetch(url, { method: 'HEAD' });
    console.log(`HEAD ${url} → HTTP ${check.status} (${check.statusText})`);
    console.log('===================================');
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    console.error('=====================');
    process.exit(1);
  }
}

main();
