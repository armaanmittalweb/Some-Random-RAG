import { MongoClient } from 'mongodb';

export interface Env {
  GEMINI_API_KEY: string;
  MONGODB_URI: string;
  MONGODB_DATABASE: string;
  MONGODB_COLLECTION: string;
  MONGODB_VECTOR_INDEX?: string;
  GEMINI_CHAT_MODEL?: string;
  GEMINI_CHAT_FALLBACK_MODEL?: string;
  GEMINI_CHAT_MODEL_CHAIN?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  ASSETS: Fetcher;
}

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_CHAT_MODEL_CHAIN = [
  { name: 'gemma-4-31b-it', timeoutMs: 12000 },
  { name: 'gemini-3.5-flash', timeoutMs: 10000 },
  { name: 'gemini-2.5-flash', timeoutMs: 9000 },
  { name: 'gemini-2.5-flash-lite', timeoutMs: 7000 }
];
const OPERATION_TIMEOUT_MS = 15000;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8'
};

let cachedDbClient: MongoClient | null = null;
let cachedDbUri: string | null = null;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs))
  ]);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
    return body as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON request body: ${errorMessage(error)}`);
  }
}

async function getMongoClient(uri: string): Promise<MongoClient> {
  if (cachedDbClient && cachedDbUri === uri) return cachedDbClient;
  if (cachedDbClient) await cachedDbClient.close().catch(() => undefined);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await withTimeout(client.connect(), 'MongoDB connection', 10000);
  cachedDbClient = client;
  cachedDbUri = uri;
  return client;
}

async function getEmbedding(text: string, apiKey: string, embeddingModel = DEFAULT_EMBEDDING_MODEL): Promise<number[]> {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${embeddingModel}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768
      })
    }
  );
  const data = await response.json() as {
    embedding?: { values?: unknown };
    error?: { message?: string; status?: string; code?: number };
  };
  if (!response.ok || data.error) {
    const detail = data.error?.message || `${response.status} ${response.statusText}`;
    console.error('Gemini embedding request failed', { status: response.status, error: data.error });
    throw new Error(`Gemini embedding error: ${detail}`);
  }
  if (!data.embedding || !Array.isArray(data.embedding.values)) {
    console.error('Gemini embedding response had no vector', data);
    throw new Error('Gemini embedding response did not contain embedding.values.');
  }
  const vector = data.embedding.values.filter((value): value is number => typeof value === 'number');
  if (vector.length !== 768) throw new Error(`Gemini embedding returned ${vector.length} dimensions; expected 768.`);
  return vector;
}

async function generateAnswer(prompt: string, apiKey: string, model: string, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch (error) {
    const timeoutError = new Error(`Gemini generation request failed: ${errorMessage(error)}`) as Error & { status?: number };
    timeoutError.status = 504;
    throw timeoutError;
  }
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string; status?: string; code?: number };
  };
  if (!response.ok || data.error) {
    const detail = data.error?.message || `${response.status} ${response.statusText}`;
    console.error('Gemini generation request failed', { status: response.status, error: data.error });
    const error = new Error(`Gemini generation error: ${detail}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!answer) throw new Error('Gemini generation response did not contain an answer.');
  return answer;
}

function getChatModelChain(env: Env): Array<{ name: string; timeoutMs: number }> {
  const configured = env.GEMINI_CHAT_MODEL_CHAIN?.split(',').map((name) => name.trim()).filter(Boolean);
  const names = configured?.length
    ? configured
    : [env.GEMINI_CHAT_MODEL, env.GEMINI_CHAT_FALLBACK_MODEL, ...DEFAULT_CHAT_MODEL_CHAIN.map((model) => model.name)].filter(Boolean) as string[];
  const uniqueNames = [...new Set(names)];
  return uniqueNames.map((name) => {
    const defaultModel = DEFAULT_CHAT_MODEL_CHAIN.find((model) => model.name === name);
    return { name, timeoutMs: defaultModel?.timeoutMs || 8000 };
  });
}

function getCollection(env: Env, client: MongoClient) {
  return client.db(env.MONGODB_DATABASE).collection(env.MONGODB_COLLECTION);
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: "Missing 'text' field. Expected a non-empty string." }, 400);

  const embedding = await getEmbedding(text, env.GEMINI_API_KEY, env.GEMINI_EMBEDDING_MODEL);
  const client = await getMongoClient(env.MONGODB_URI);
  const result = await getCollection(env, client).insertOne({ text, embedding, createdAt: new Date() });
  return json({ message: 'Document ingested successfully.', id: result.insertedId }, 201);
}

async function chat(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json({ error: "Missing 'query' field. Expected a non-empty string." }, 400);

  const queryVector = await getEmbedding(query, env.GEMINI_API_KEY, env.GEMINI_EMBEDDING_MODEL);
  const client = await getMongoClient(env.MONGODB_URI);
  const searchResults = await withTimeout(getCollection(env, client).aggregate([
    { $vectorSearch: {
      index: env.MONGODB_VECTOR_INDEX || 'default',
      path: 'embedding',
      queryVector,
      numCandidates: 50,
      limit: 10
    } },
    { $project: { _id: 0, text: 1, score: { $meta: 'vectorSearchScore' } } }
  ], { maxTimeMS: OPERATION_TIMEOUT_MS }).toArray(), 'MongoDB vector search');
  const context = searchResults.map((document) => String(document.text)).join('\n\n') || 'No context found.';
  const prompt = `You are a careful research assistant. Answer only from the retrieved context. If the context does not contain the answer, say so.\n\nRetrieved context:\n${context}\n\nUser question: ${query}`;
  const modelChain = getChatModelChain(env);
  const failures: string[] = [];
  let answer: string | undefined;
  let usedModel: string | undefined;
  let fallbackLevel: number | undefined;
  for (const [index, model] of modelChain.entries()) {
    try {
      answer = await generateAnswer(prompt, env.GEMINI_API_KEY, model.name, model.timeoutMs);
      usedModel = model.name;
      fallbackLevel = index + 1;
      break;
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      failures.push(`${model.name}: ${errorMessage(error)}`);
      if (![408, 429, 500, 502, 503, 504].includes(status || 0)) throw error;
      console.warn(`Gemini model unavailable; trying next level`, { model: model.name, status });
    }
  }
  if (!answer) throw new Error(`All Gemini chat models failed. ${failures.join(' | ')}`);
  return json({ answer, contextUsed: searchResults, modelUsed: usedModel, fallbackLevel });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ingest' && request.method === 'POST') return await ingest(request, env);
      if (url.pathname === '/api/chat' && request.method === 'POST') return await chat(request, env);
      if (url.pathname === '/api/status' && request.method === 'GET') return json({ gemini: Boolean(env.GEMINI_API_KEY), mongo: Boolean(env.MONGODB_URI), indexedChunks: null });
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      return json({ error: 'Endpoint not found.' }, 404);
    } catch (error) {
      console.error('Request failed', error);
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: errorMessage(error) }, status);
    }
  }
};
