/* Diagnostic: does cancelling a reader over a Response-wrapped stream invoke the
   underlying source cancel()? Mirrors the A2 shape (43 single-byte chunks). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shape(label, { wrapInResponse, pullMode }) {
  let cancelCount = 0;
  let index = 0;
  const chunks = Array.from({ length: 43 }, () => new TextEncoder().encode('a'));
  const source = {
    pull(controller) {
      if (pullMode === 'pending' && index >= 3) return new Promise(() => {});
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]);
    },
    cancel() { cancelCount += 1; },
  };
  const stream = new ReadableStream(source);
  const body = wrapInResponse
    ? new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }).body
    : stream;
  const reader = body.getReader();
  for (let i = 0; i < 43; i += 1) {
    const next = await reader.read();
    if (next.done) break;
  }
  let cancelError = null;
  try { await reader.cancel(); } catch (e) { cancelError = String(e && e.message || e); }
  await sleep(20);
  console.log(label + ' -> sourceCancel=' + cancelCount + ' cancelError=' + cancelError + ' bodyIsSource=' + (body === stream));
}

(async () => {
  await shape('raw stream, 43 chunks', { wrapInResponse: false, pullMode: 'finite' });
  await shape('Response-wrapped, 43 chunks', { wrapInResponse: true, pullMode: 'finite' });
  await shape('Response-wrapped, pending pull', { wrapInResponse: true, pullMode: 'pending' });
})();
