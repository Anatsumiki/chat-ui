// netlify/functions/chat.mjs
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages, model, endpoint, maxTokens, temperature } = await req.json();
    const apiKey = process.env.API_KEY;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return new Response(`Upstream error: ${err}`, { status: upstream.status });
    }

    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}