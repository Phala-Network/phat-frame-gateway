interface SerizliedRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  queries: Record<string, string[]>;
  headers: Record<string, string>;
  body: string;
  secret?: Record<string, unknown>;
}

export default async function main(payload: string) {
  const request: SerizliedRequest = JSON.parse(payload);
  const answer = request.secret?.answer ?? '42'
  const name = request.secret?.name ?? 'World'
  return JSON.stringify({
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age: 60',
      'Expires': new Date(Date.now() + 60 * 1000).toUTCString(),
    },
    body: `Hi ${name}, the answer is ${answer}!`,
  })
}
