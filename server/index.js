import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MongoClient } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3001);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transcriptFiles = ['Transcript_1_France.txt', 'Transcript_2_Germany.txt', 'Transcript_3_UK.txt'];
const guidePath = path.join(root, 'Interview_Guide.txt');
const config = {
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || 'transcript_rag',
  chunksCollection: process.env.MONGODB_COLLECTION || 'transcript_chunks',
  cacheCollection: process.env.MONGODB_CACHE_COLLECTION || 'answer_cache',
  vectorIndex: process.env.MONGODB_VECTOR_INDEX || 'transcript_vector_index',
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
  fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
  similarityModel: process.env.GEMINI_SIMILARITY_MODEL,
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

let mongo;
let db;
let chunks = [];
let guide = '';
let gemini;

function parseTranscript(text, fileName) {
  const header = text.match(/^Expert[^\n]+\nRole: ([^\n]+)\nMarket: ([^\n]+)/m);
  const expert = header?.[0].split('\n')[0].replace(/^Expert \d+ – /, '').trim() || fileName;
  const role = header?.[1]?.trim() || '';
  const market = header?.[2]?.trim() || '';
  const blocks = text.split(/\r?\n(?=\d{2}:\d{2}\r?\n)/).filter(Boolean);
  return blocks.map((block) => {
    const match = block.match(/^(\d{2}:\d{2})\r?\n([^:]+): ([\s\S]+?)\r?$/);
    if (!match) return null;
    return {
      source: fileName,
      expert,
      role,
      market,
      timestamp: match[1],
      speaker: match[2].trim(),
      text: match[3].trim(),
      chunkText: `${expert} (${market}), ${match[1]}, ${match[2].trim()}: ${match[3].trim()}`
    };
  }).filter(Boolean);
}

async function loadCorpus() {
  guide = await fs.readFile(guidePath, 'utf8');
  const loaded = await Promise.all(transcriptFiles.map(async (fileName) => {
    const text = await fs.readFile(path.join(root, fileName), 'utf8');
    return parseTranscript(text, fileName);
  }));
  chunks = loaded.flat();
}

async function embed(text) {
  if (!gemini || !config.embeddingModel) return null;
  const result = await gemini.getGenerativeModel({ model: config.embeddingModel }).embedContent(text);
  return result.embedding.values;
}

async function generateWithRetry(modelName, prompt) {
  const model = gemini.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.1 } });
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      lastError = error;
      if (error.status !== 429 && error.status !== 500 && error.status !== 503) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function setupMongo() {
  if (!config.mongoUri) return;
  mongo = new MongoClient(config.mongoUri);
  await mongo.connect();
  db = mongo.db(config.dbName);
  const collection = db.collection(config.chunksCollection);
  for (const chunk of chunks) {
    const embedding = await embed(chunk.chunkText);
    await collection.updateOne(
      { source: chunk.source, timestamp: chunk.timestamp, text: chunk.text },
      { $set: { ...chunk, embedding, indexedAt: new Date() } },
      { upsert: true }
    );
  }
}

function fallbackRetrieve(question) {
  const terms = question.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  return chunks.map((chunk) => ({
    ...chunk,
    score: terms.reduce((score, term) => score + (chunk.chunkText.toLowerCase().includes(term) ? 1 : 0), 0)
  })).sort((a, b) => b.score - a.score).slice(0, 10);
}

async function retrieve(question) {
  if (!db) return fallbackRetrieve(question);
  const queryVector = await embed(question);
  if (!queryVector) return fallbackRetrieve(question);
  const results = await db.collection(config.chunksCollection).aggregate([
    { $vectorSearch: { index: config.vectorIndex, path: 'embedding', queryVector, numCandidates: 40, limit: 10 } },
    { $project: { _id: 0, source: 1, expert: 1, role: 1, market: 1, timestamp: 1, speaker: 1, text: 1, score: { $meta: 'vectorSearchScore' } } }
  ]).toArray();
  return results.length ? results : fallbackRetrieve(question);
}

function sourceLabel(source) {
  return source.replace('Transcript_', '').replace('.txt', '').replace('_', ' ');
}

function makeContext(results) {
  return results.map((item, index) => `[${index + 1}] ${item.expert} | ${sourceLabel(item.source)} | ${item.timestamp}\n${item.speaker}: ${item.text}`).join('\n\n');
}

async function findCached(question, questionEmbedding) {
  if (!db || !config.similarityModel) return null;
  const cached = await db.collection(config.cacheCollection).find({}).sort({ createdAt: -1 }).limit(30).toArray();
  if (!cached.length) return null;
  const classifier = gemini.getGenerativeModel({ model: config.similarityModel });
  for (const item of cached) {
    const prompt = `Decide whether these two questions ask for substantially the same answer based on the transcript evidence. Reply with only YES or NO.\nQuestion A: ${item.question}\nQuestion B: ${question}`;
    const response = await classifier.generateContent(prompt);
    if (response.response.text().trim().toUpperCase().startsWith('YES')) return item;
  }
  return null;
}

async function answerQuestion(question, results) {
  if (!gemini || !config.model) throw new Error('Gemini is not configured. Add GEMINI_API_KEY and GEMINI_MODEL to .env.');
  const prompt = `You are a careful research analyst. Answer the user question using only the transcript excerpts below. Do not invent facts or blend unsupported claims. Every material claim must include one or more citation markers like [1] that map to an excerpt. Include exact short quotes only when useful. If the evidence is insufficient, say so. Keep the response concise and structured.\n\nInterview guide:\n${guide}\n\nTranscript excerpts:\n${makeContext(results)}\n\nUser question: ${question}`;
  try {
    const response = await generateWithRetry(config.model, prompt);
    return response.response.text();
  } catch (error) {
    if (!config.fallbackModel || ![429, 500, 503].includes(error.status)) throw error;
    console.warn(`Primary Gemini model unavailable; trying ${config.fallbackModel}`);
    const response = await generateWithRetry(config.fallbackModel, prompt);
    return response.response.text();
  }
}

app.get('/api/status', (_req, res) => res.json({
  mongo: Boolean(db),
  gemini: Boolean(gemini && config.model),
  indexedChunks: chunks.length,
  markets: [...new Set(chunks.map((chunk) => chunk.market))]
}));

app.get('/api/guide', (_req, res) => res.json({ guide, questions: guide.split('\n').filter((line) => /^\d+\./.test(line)).map((line) => line.trim()) }));

app.post('/api/ask', async (req, res) => {
  const question = String(req.body.question || '').trim();
  const shouldCache = Boolean(req.body.cache);
  if (!question) return res.status(400).json({ error: 'Ask a question first.' });
  try {
    const cached = await findCached(question);
    if (cached) return res.json({ answer: cached.answer, sources: cached.sources, cached: true, cachedQuestion: cached.question });
    const results = await retrieve(question);
    const answer = await answerQuestion(question, results);
    const sources = results.map((item, index) => ({ id: index + 1, expert: item.expert, market: item.market, timestamp: item.timestamp, speaker: item.speaker, text: item.text, source: item.source }));
    if (shouldCache && db) await db.collection(config.cacheCollection).insertOne({ question, answer, sources, embedding: await embed(question), createdAt: new Date() });
    res.json({ answer, sources, cached: false, cacheSaved: shouldCache && Boolean(db) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Unable to answer question.' });
  }
});

await loadCorpus();
if (config.apiKey) gemini = new GoogleGenerativeAI(config.apiKey);
try { await setupMongo(); } catch (error) { console.error('MongoDB setup failed; using local retrieval fallback:', error.message); }
app.listen(port, () => console.log(`API listening on http://localhost:${port} (${chunks.length} transcript chunks loaded)`));
