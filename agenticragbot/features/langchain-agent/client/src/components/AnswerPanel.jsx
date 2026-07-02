import { useMemo, useState } from 'react';

const CITATION_RE = /\[([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}#[a-z0-9-]+)\]/gi;

function renderAnswer(text) {
  const parts = [];
  let lastIndex = 0;
  let key = 0;
  let match;

  CITATION_RE.lastIndex = 0;
  while ((match = CITATION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }
    const id = match[1];
    const label = id.split('#')[1] || 'source';
    parts.push(
      <a key={key++} href={`#source-${id}`} className="citation" title={id}>
        {label}
      </a>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }
  return parts;
}

export default function AnswerPanel({ result }) {
  const [copied, setCopied] = useState(false);
  const rendered = useMemo(() => (result ? renderAnswer(result.answer) : null), [result]);

  if (!result) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(result.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable, ignore */
    }
  }

  return (
    <section className="panel answer-panel">
      <div className="panel-header">
        <h2>Answer</h2>
        <button className="icon-btn" onClick={handleCopy} type="button">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      {result.question && <p className="question-echo">&ldquo;{result.question}&rdquo;</p>}
      <p className="answer-text">{rendered}</p>
      <div className="badges">
        <span className={`badge ${result.confident ? 'badge-confident' : 'badge-unsure'}`}>
          {result.confident ? '✓ Confident on Pass 1' : '⟳ Needed more context'}
        </span>
        <span className={`badge ${result.pass2Triggered ? 'badge-pass2-on' : 'badge-pass2-off'}`}>
          Pass 2 {result.pass2Triggered ? 'triggered' : 'not needed'}
        </span>
        {result.toolCalls?.length > 0 && (
          <span className="badge badge-neutral">
            {result.toolCalls.length} search call{result.toolCalls.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </section>
  );
}
