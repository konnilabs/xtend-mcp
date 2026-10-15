export async function readLimited(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Object.assign(new Error('Body exceeds byte budget'), { status: 413 });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) { await reader.cancel(); throw Object.assign(new Error('Body exceeds byte budget'), { status: 413 }); }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
