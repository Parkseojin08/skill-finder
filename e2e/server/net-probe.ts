// Run by the launcher with the server's own environment, before the server: says whether this Node sends fetch
// through the proxy settings (NODE_USE_ENV_PROXY, Node 24 or 22.21 and later). If it does not, the server would
// reach the real GitHub and skills.sh, so the launcher stops instead.
//
// The address is one that leads nowhere (192.0.2.1, kept for documentation): through the proxy settings the request
// is refused on this PC at once; without them it waits and runs into the time limit. Exit code 0: refused here.
const BLACKHOLE_PORT = process.argv[2] ?? '9';

type ErrLike = { name?: string; message?: string; code?: string; cause?: ErrLike };

const outcome = await fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(4000) }).then(
  (res) => `answered with ${res.status}`,
  (err: ErrLike) => {
    const cause = err.cause ?? err;
    const refusedHere = cause.code === 'ECONNREFUSED' && (cause.message ?? '').includes(`127.0.0.1:${BLACKHOLE_PORT}`);
    return refusedHere ? null : `${err.name ?? 'Error'}: ${cause.message ?? err.message ?? ''}`;
  },
);

if (outcome !== null) {
  console.error(outcome);
  process.exit(1);
}
