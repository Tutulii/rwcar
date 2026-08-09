export const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

export async function apiRequest(path, { token, body, method } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `API request failed (${response.status})`);
    error.code = payload.code;
    error.correlationId = payload.correlationId;
    error.details = payload.details;
    throw error;
  }
  return payload;
}
