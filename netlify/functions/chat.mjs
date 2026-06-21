// netlify/functions/chat.mjs
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages, model, endpoint, maxTokens, temperature, apiKey } =
      await req.json();
    const key = apiKey || process.env.API_KEY;

    if (!key) {
      return new Response(
        JSON.stringify({
          error: '请配置 API Key，或在浏览器弹窗中填写你自己的 Key',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const upstream = await fetch(endpoint, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return new Response(`Upstream error: ${err}`, {
        status: upstream.status,
      });
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
