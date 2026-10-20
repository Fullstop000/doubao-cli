// A task that needs no local tools may finish before the SSE tool channel
// flushes its headers. Observe the server turn while the runtime starts.
export async function waitWithLocalRuntime(waitForTurn, startRuntime, { abortStartup } = {}) {
  const waiter = new AbortController();
  let engine;
  const startup = Promise.resolve().then(startRuntime).then(value => { engine = value; });
  const startupFailure = startup.then(() => new Promise(() => {}));
  const waiting = Promise.resolve().then(() => waitForTurn(waiter.signal));
  try {
    return await Promise.race([waiting, startupFailure]);
  } finally {
    waiter.abort();
    if (!engine) abortStartup?.();
    await Promise.allSettled([startup, waiting]);
    await engine?.close();
  }
}
