/**
 * Mock Child Process Runner for Child Lifecycle Unit Tests (Wave 15, W15-A)
 */
const scenario = process.env.SCENARIO || 'ready-then-step';

switch (scenario) {
  case 'exit-immediately':
    process.exit(1);
    break;

  case 'exit-error':
    console.error('Simulated fatal startup error in child worker');
    process.exit(2);
    break;

  case 'ready-then-hang':
    if (process.send) {
      process.send({ type: 'ready', pid: process.pid });
    }
    // Deliberately hang without sending step barrier
    setInterval(() => {}, 60_000);
    break;

  case 'ready-then-step':
  default:
    if (process.send) {
      process.send({ type: 'ready', pid: process.pid });
      setTimeout(() => {
        if (process.send) {
          process.send({ type: 'step_held', step: 'extract:connector-inference', pid: process.pid });
        }
      }, 50);
    }
    setInterval(() => {}, 60_000);
    break;
}
