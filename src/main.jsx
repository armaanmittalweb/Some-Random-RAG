import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import './styles.css';

const starterQuestions = [
  'Compare the main barriers to robotic surgery adoption across France, Germany, and the UK.',
  'What do the experts say about ROI, hospital budgets, and clinical outcomes?',
  'What adoption trend is expected over the next 3–5 years?'
];

function App() {
  const [question, setQuestion] = useState(starterQuestions[0]);
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cache, setCache] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/status').then((response) => response.json()).then(setStatus).catch(() => setError('The API is not reachable. Start the app with npm run dev.'));
  }, []);

  async function ask(event) {
    event?.preventDefault();
    if (!question.trim() || loading) return;
    setLoading(true); setError(''); setAnswer(null);
    try {
      const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, cache }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAnswer(data);
    } catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-mark">F</span><span>fieldnotes<span className="dot">.</span></span></a>
      <div className="topbar-meta"><span className="eyebrow">EUROPEAN ROBOTIC SURGERY</span><span className={`status-dot ${status?.gemini && status?.mongo ? 'ready' : ''}`} /> <span>{status ? `${status.indexedChunks} transcript notes indexed` : 'Connecting'}</span></div>
    </header>

    <main>
      <section className="intro">
        <p className="kicker">Three expert calls · France · Germany · UK</p>
        <h1>Find the signal<br /><em>in the conversation.</em></h1>
        <p className="intro-copy">Ask across the interviews. Every answer stays close to the source, with timestamps and exact voices you can follow.</p>
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading"><span className="section-label">Interview guide</span><span className="count">06</span></div>
          <div className="question-list">
            {[...starterQuestions, 'How long does a hospital purchase decision take?', 'How important are training and clinical outcomes?'].map((item, index) => <button className={`guide-question ${question === item ? 'selected' : ''}`} key={item} onClick={() => setQuestion(item)}><span>0{index + 1}</span><strong>{item}</strong></button>)}
          </div>
          <div className="side-note"><span className="quote-mark">“</span><p>Grounded in 3 transcripts<br />and 18 timestamped notes.</p></div>
        </aside>

        <section className="answer-panel">
          <div className="panel-heading"><div><span className="section-label">Research desk</span><h2>Ask the interviews</h2></div><span className="model-pill">GEMINI · RAG</span></div>
          <form onSubmit={ask} className="ask-form">
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question across all three interviews..." rows="3" />
            <div className="form-footer"><label className="cache-toggle"><input type="checkbox" checked={cache} onChange={(event) => setCache(event.target.checked)} /><span className="toggle" /><span>Save answer for similar questions</span></label><button className="ask-button" type="submit" disabled={loading}>{loading ? 'Thinking...' : 'Ask fieldnotes'} <span>↗</span></button></div>
          </form>

          {error && <div className="error-box">{error}</div>}
          {!answer && !loading && !error && <div className="empty-state"><span className="empty-icon">↳</span><h3>Start with a question</h3><p>Choose a prompt from the guide or write your own. The answer will include the voices and timestamps behind it.</p></div>}
          {loading && <div className="loading-state"><span className="loader" /><p>Searching the interview notes and checking the evidence...</p></div>}
          {answer && <Answer answer={answer} />}
        </section>
      </section>
    </main>
    <footer><span>FIELDNOTES / CASE STUDY</span><span>Source-grounded research workspace</span></footer>
  </div>;
}

function Answer({ answer }) {
  return <div className="result">
    <div className="result-top"><span className="section-label">Synthesis</span>{answer.cached && <span className="cached-pill">Cached answer · similar question</span>}</div>
    <div className="answer-copy"><ReactMarkdown>{answer.answer}</ReactMarkdown></div>
    <div className="sources-heading"><span className="section-label">Evidence trail</span><span>{answer.sources?.length || 0} source notes</span></div>
    <div className="sources">{answer.sources?.map((source) => <article className="source" key={`${source.source}-${source.timestamp}`}><div className="source-meta"><span className="source-number">[{source.id}]</span><strong>{source.market}</strong><span>{source.timestamp}</span></div><p><b>{source.speaker}:</b> “{source.text}”</p></article>)}</div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
