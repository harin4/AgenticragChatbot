export default function AskForm({ question, onQuestionChange, onAsk, loading }) {
  function handleSubmit(e) {
    e.preventDefault();
    if (!question.trim() || loading) return;
    onAsk(question.trim());
  }

  return (
    <form className="ask-form" onSubmit={handleSubmit}>
      <label htmlFor="question">Ask about MergeX</label>
      <div className="ask-row">
        <input
          id="question"
          type="text"
          placeholder="e.g. What is the S.C.A.L.E. Methodology?"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <button type="submit" disabled={loading || !question.trim()}>
          {loading && <span className="btn-spinner" />}
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </form>
  );
}
