# Fieldnotes

A small, source-grounded RAG workspace for the European robotic surgery expert calls in this case.

## Run locally

1. Install Node.js 18+ and MongoDB Atlas access.
2. Copy `.env.example` to `.env` and fill in `GEMINI_API_KEY`, the three Gemini model names, and `MONGODB_URI`.
3. In MongoDB Atlas, create a vector search index named `transcript_vector_index` on `transcript_chunks`:

```json
{
	"fields": [
		{ "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" }
	]
}
```

4. Start the app:

```bash
npm run dev
```

Open `http://localhost:5173`.

## Deploy the frontend to Cloudflare Workers

The React frontend is deployable to Cloudflare Workers. The existing Express API remains a Node service because it uses the filesystem and MongoDB's Node driver. Deploy that API to a Node host first, then set its public URL as `API_ORIGIN` in `wrangler.jsonc`.

For a local deployment from the CLI:

```bash
npx wrangler login
# edit API_ORIGIN in wrangler.jsonc
npm run deploy:cloudflare
```

For Git-based deployment, push this repository to GitHub and add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: token with Workers Scripts edit permission
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID

Every push to `main` then builds and deploys the Worker through `.github/workflows/deploy-cloudflare.yml`. The Worker serves the React assets and forwards `/api/*` requests to `API_ORIGIN`, so no frontend code changes are needed.

### Worker secrets

Set the runtime secrets on the Worker from the repository root. Wrangler will prompt securely for each value:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MONGODB_URI
npx wrangler secret put MONGODB_DATABASE
npx wrangler secret put MONGODB_COLLECTION
npx wrangler secret put MONGODB_VECTOR_INDEX
npx wrangler secret put GEMINI_CHAT_MODEL
```

`GEMINI_API_KEY` and `MONGODB_URI` should be secrets. The database, collection, vector index, and chat model may also be configured as Wrangler variables, but using secrets keeps deployment configuration consistent. The MongoDB collection must have an Atlas Vector Search index whose vector path is `embedding`, dimension is `768`, and name matches `MONGODB_VECTOR_INDEX`.

The API parses the supplied transcripts at startup and upserts one MongoDB document per timestamped speaker turn. Gemini creates the embeddings and produces low-temperature answers from retrieved excerpts only. The UI renders the numbered evidence trail that the model cites. When “Save answer for similar questions” is enabled, the answer and its citations are stored in the cache collection. A second Gemini model classifies whether a new question is substantially equivalent to a cached question before reusing it.

Without `.env` credentials, the API still starts and reports its 42 parsed notes, but answering requires Gemini configuration and Atlas vector retrieval is unavailable. This makes the UI and parser easy to inspect without silently pretending that a local fallback is production retrieval.

## Scaling notes

For 30+ transcripts, ingestion should move to a queued job with checksum-based upserts, batch embedding, and parser validation. Retrieval can add metadata filters for market, role, and date, while the cache classifier can first use embedding similarity to reduce Gemini calls. MongoDB Atlas vector search keeps the retrieval layer horizontally manageable; the answer prompt should retain the same strict citation contract.