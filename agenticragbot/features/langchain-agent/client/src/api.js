const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const TIMEOUT_MS = 90_000;

export async function askQuestion(question) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The request took too long and timed out. The backend may be stuck or unreachable.');
    }
    throw new Error(
      `Could not reach the agent API at ${API_URL}. Is the backend running? Start it with "npm run agent:dev" from the repo root.`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server returned an invalid response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}
