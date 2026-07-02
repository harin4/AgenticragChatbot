import { useEffect, useRef, useState } from 'react';
import AskForm from './components/AskForm.jsx';
import AnswerPanel from './components/AnswerPanel.jsx';
import SourcesPanel from './components/SourcesPanel.jsx';
import { askQuestion } from './api.js';

const EXAMPLE_QUESTIONS = [
  'What is the S.C.A.L.E. Methodology?',
  'What is the MergeX ecosystem?',
  'What are the four rules?',
];

export default function App() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  async function handleAsk(q) {
    setQuestion(q);
    setLoading(true);
    setError(null);
    setElapsedMs(0);

    const start = Date.now();
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - start), 200);

    try {
      const data = await askQuestion(q);
      setResult({ ...data, question: q });
      setHistory((h) => [q, ...h.filter((item) => item !== q)].slice(0, 6));
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      clearInterval(timerRef.current);
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <h1>MergeX Knowledge Assistant</h1>
            <p className="subtitle">Agentic RAG · LangChain.js · ChatGroq · CohereEmbeddings · Qdrant</p>
          </div>
        </div>
      </header>

      <AskForm question={question} onQuestionChange={setQuestion} onAsk={handleAsk} loading={loading} />

      {!result && !loading && (
        <div className="chip-row">
          <span className="chip-row-label">Try asking</span>
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} className="chip" onClick={() => handleAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="chip-row">
          <span className="chip-row-label">Recent</span>
          {history.map((q) => (
            <button key={q} className="chip chip-ghost" onClick={() => handleAsk(q)} disabled={loading}>
              {q}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="error">
          <strong>Something went wrong.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="loading">
          <span className="spinner" />
          Searching the knowledge base and reasoning… ({(elapsedMs / 1000).toFixed(1)}s)
        </div>
      )}

      <AnswerPanel result={result} />
      <SourcesPanel result={result} />
    </div>
  );
}
