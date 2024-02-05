interface SerizliedRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  queries: Record<string, string[]>;
  headers: Record<string, string>;
  body: string;
  secret?: Record<string, unknown>;
}

export default async function main(payload: string) {
  return JSON.stringify({
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age: 60',
      'Expires': new Date(Date.now() + 60 * 1000).toUTCString(),
    },
    body: payload,
  })
}
