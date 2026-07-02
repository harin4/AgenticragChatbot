export default function SourcesPanel({ result }) {
  if (!result) return null;

  const expanded = new Set(result.expandedChunkIds || []);
  const cited = new Set(result.citedChunkIds || []);
  const count = result.sources?.length || 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Sources &amp; retrieval trail</h2>
        <span className="source-count">
          {count} chunk{count === 1 ? '' : 's'}
        </span>
      </div>

      {result.toolCalls?.length > 0 && (
        <div className="tool-calls">
          <h3>search_mergex_knowledge calls</h3>
          <ul>
            {result.toolCalls.map((call, i) => (
              <li key={i}>
                <code>&quot;{call.query}&quot;</code> → {call.resultCount} chunk{call.resultCount === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {count > 0 ? (
        <ul className="sources-list">
          {result.sources.map((s) => (
            <li key={s.id} id={`source-${s.id}`} className="source-item">
              <div className="source-header">
                <span className="source-heading">{(s.heading_path || []).join(' > ') || s.id}</span>
                {cited.has(s.id) && <span className="tag tag-cited">cited</span>}
                {expanded.has(s.id) && <span className="tag tag-expanded">via related_ids (pass 2)</span>}
              </div>
              <div className="source-meta">
                <span className="source-id">{s.id}</span>
                {s.score !== null && s.score !== undefined && (
                  <span className="score-bar-wrap" title={`similarity ${s.score.toFixed(3)}`}>
                    <span className="score-bar" style={{ width: `${Math.max(4, s.score * 100)}%` }} />
                  </span>
                )}
                <span className="via-tag">{s.via}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No chunks were retrieved for this question.</p>
      )}
    </section>
  );
}
