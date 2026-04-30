import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://crof.ai/v1';
const DEFAULT_MODEL = 'deepseek-v4-pro-precision';
const DEFAULT_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const result = {
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    effort: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    envFile: undefined,
    prompts: [],
    raw: false,
    visionText: undefined,
    imagePath: undefined,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--model') {
      result.model = argv[++index] ?? result.model;
      continue;
    }
    if (arg === '--base-url') {
      result.baseUrl = argv[++index] ?? result.baseUrl;
      continue;
    }
    if (arg === '--effort') {
      result.effort = argv[++index];
      continue;
    }
    if (arg === '--timeout-ms') {
      result.timeoutMs = Number(argv[++index] ?? result.timeoutMs);
      continue;
    }
    if (arg === '--env-file') {
      result.envFile = argv[++index];
      continue;
    }
    if (arg === '--raw') {
      result.raw = true;
      continue;
    }
    if (arg === '--vision-text') {
      result.visionText = argv[++index];
      continue;
    }
    if (arg === '--image-path') {
      result.imagePath = argv[++index];
      continue;
    }
    result.prompts.push(arg);
  }

  return result;
}

function loadEnvFile(envFilePath) {
  if (!envFilePath) {
    return;
  }
  const absolutePath = path.resolve(envFilePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Env file not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getApiKey() {
  return process.env.CROF_API_KEY || process.env.CROFAI_API_KEY;
}

function extractSseEvents(buffer) {
  const events = [];
  let start = 0;

  while (true) {
    let separatorIndex = buffer.indexOf('\n\n', start);
    let separatorLength = 2;
    const windowsSeparatorIndex = buffer.indexOf('\r\n\r\n', start);
    if (windowsSeparatorIndex !== -1 && (separatorIndex === -1 || windowsSeparatorIndex < separatorIndex)) {
      separatorIndex = windowsSeparatorIndex;
      separatorLength = 4;
    }

    if (separatorIndex === -1) {
      break;
    }

    const rawEvent = buffer.slice(start, separatorIndex);
    start = separatorIndex + separatorLength;
    if (!rawEvent.trim()) {
      continue;
    }

    let eventName;
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    events.push({ event: eventName, data: dataLines.join('\n') });
  }

  return {
    events,
    rest: buffer.slice(start),
  };
}

async function runTurn({ baseUrl, apiKey, model, effort, timeoutMs, messages, raw }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);

  const requestBody = {
    model,
    messages,
    stream: true,
    ...(effort ? { reasoning_effort: effort } : {}),
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'crofai-session-tester',
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    clearTimeout(timeoutId);
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let sawReasoningOnly = false;
  let emittedText = '';
  let chunkCount = 0;
  let usage;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.rest;

      for (const event of parsed.events) {
        if (!event.data || event.data === '[DONE]') {
          continue;
        }

        if (event.event === 'error') {
          throw new Error(`SSE error event: ${event.data}`);
        }

        const chunk = JSON.parse(event.data);
        chunkCount += 1;
        usage = chunk.usage ?? usage;

        const delta = chunk.choices?.[0]?.delta ?? {};
        const content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;

        if (raw) {
          console.log(`\n[chunk ${chunkCount}] ${event.data}`);
        }

        if (content != null) {
          emittedText += String(content);
          process.stdout.write(String(content));
          continue;
        }

        if (reasoning != null) {
          sawReasoningOnly = true;
          emittedText += String(reasoning);
          process.stdout.write(String(reasoning));
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    emittedText,
    sawReasoningOnly,
    chunkCount,
    usage,
    tail: buffer.trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.envFile);

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Set CROF_API_KEY or CROFAI_API_KEY, or pass --env-file /path/to/.env');
  }

  let messages = [];
  let visionMode = args.visionText && args.imagePath;

  console.log(`Base URL: ${args.baseUrl}`);
  console.log(`Model: ${args.model}`);
  if (args.effort) {
    console.log(`Reasoning effort: ${args.effort}`);
  }

  if (visionMode) {
    // Read local image and convert to data URL — no CDN upload needed
    let imageUrl = args.imagePath;
    if (args.imagePath.startsWith('/') || args.imagePath.startsWith('file://')) {
      const localPath = args.imagePath.replace(/^file:\/\//, '');
      const mime = localPath.endsWith('.png') ? 'image/png'
        : localPath.endsWith('.jpg') || localPath.endsWith('.jpeg') ? 'image/jpeg'
        : localPath.endsWith('.webp') ? 'image/webp'
        : localPath.endsWith('.gif') ? 'image/gif'
        : 'image/png';
      const raw = fs.readFileSync(localPath);
      const b64 = raw.toString('base64');
      imageUrl = `data:${mime};base64,${b64}`;
      console.log('Using data URL for image');
    }
    messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: args.visionText },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];
    console.log(`\n=== Vision Turn ===`);
    console.log(`User: ${args.visionText} [image: ${imageUrl}]`);
    process.stdout.write('Assistant: ');

    const result = await runTurn({
      baseUrl: args.baseUrl,
      apiKey,
      model: args.model,
      effort: args.effort,
      timeoutMs: args.timeoutMs,
      messages,
      raw: args.raw,
    });

    console.log('\n');
    console.log(
      `Summary: chunks=${result.chunkCount} chars=${result.emittedText.length} reasoningFallback=${result.sawReasoningOnly}`
    );
    if (result.usage) {
      console.log(`Usage: ${JSON.stringify(result.usage)}`);
    }
    if (result.tail) {
      console.log(`Trailing buffer: ${JSON.stringify(result.tail)}`);
    }
    messages.push({ role: 'assistant', content: result.emittedText });
  } else {
    const prompts = args.prompts.length > 0 ? args.prompts : ['Hello, world!'];
    messages = [];
    for (let turnIndex = 0; turnIndex < prompts.length; turnIndex++) {
      const prompt = prompts[turnIndex];
      messages.push({ role: 'user', content: prompt });
      console.log(`\n=== Turn ${turnIndex + 1} ===`);
      console.log(`User: ${prompt}`);
      process.stdout.write('Assistant: ');

      const result = await runTurn({
        baseUrl: args.baseUrl,
        apiKey,
        model: args.model,
        effort: args.effort,
        timeoutMs: args.timeoutMs,
        messages,
        raw: args.raw,
      });

      console.log('\n');
      console.log(
        `Summary: chunks=${result.chunkCount} chars=${result.emittedText.length} reasoningFallback=${result.sawReasoningOnly}`
      );
      if (result.usage) {
        console.log(`Usage: ${JSON.stringify(result.usage)}`);
      }
      if (result.tail) {
        console.log(`Trailing buffer: ${JSON.stringify(result.tail)}`);
      }

      // OpenAI-compatible: always merge all assistant output into a single message per turn
      messages.push({ role: 'assistant', content: result.emittedText });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});