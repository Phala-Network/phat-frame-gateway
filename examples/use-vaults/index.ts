interface SerizliedRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  headers: Record<string, string>;
  body: string;
  secret?: Record<string, unknown>;
}

export default async function main(payload: string) {
  const request: SerizliedRequest = JSON.parse(payload);
  const answer = request.secret?.answer ?? '42'
  return JSON.stringify({
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, no-transform, no-cache, must-revalidate, max-age=60, s-maxage=120',
    },
    body: `{"answer": ${answer}}`
  })
}
