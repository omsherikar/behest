// Next.js calls register() once when a server instance starts, on each runtime. The Node.js
// server also runs the background job worker when WORKER is 1. Set it on one instance only.
//
// The runtime check stays a separate condition around the imports so the edge build drops them:
// the worker reaches the database drivers, which only run on Node.js.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.WORKER !== '1') return;
    const { startWorker } = await import('@/lib/jobs/worker');
    const { loadJobHandlers } = await import('@/lib/jobs/registry');
    startWorker(loadJobHandlers);
  }
}
