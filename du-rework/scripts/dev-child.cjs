let shutdownRequested = false;

function shutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (process.listenerCount('SIGTERM') > 0) {
    process.emit('SIGTERM', 'SIGTERM');
    return;
  }
  process.exit(0);
}

process.on('message', (message) => {
  if (message === 'dugate:shutdown') shutdown();
});
process.on('disconnect', shutdown);
