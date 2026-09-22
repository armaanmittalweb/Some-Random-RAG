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

The API parses the supplied transcripts at startup and upserts one MongoDB document per timestamped speaker turn. Gemini creates the embeddings and produces low-temperature answers from retrieved excerpts only. The UI renders the numbered evidence trail that the model cites. When “Save answer for similar questions” is enabled, the answer and its citations are stored in the cache collection. A second Gemini model classifies whether a new question is substantially equivalent to a cached question before reusing it.

Without `.env` credentials, the API still starts and reports its 42 parsed notes, but answering requires Gemini configuration and Atlas vector retrieval is unavailable. This makes the UI and parser easy to inspect without silently pretending that a local fallback is production retrieval.

## Scaling notes

For 30+ transcripts, ingestion should move to a queued job with checksum-based upserts, batch embedding, and parser validation. Retrieval can add metadata filters for market, role, and date, while the cache classifier can first use embedding similarity to reduce Gemini calls. MongoDB Atlas vector search keeps the retrieval layer horizontally manageable; the answer prompt should retain the same strict citation contract.