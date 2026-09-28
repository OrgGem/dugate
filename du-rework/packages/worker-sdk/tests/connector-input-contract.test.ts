import type { InvocationInput } from '@du/contracts';
import type { ConnectorInvokeInput } from '../src';

test('worker-sdk connector input aliases the canonical wire input', () => {
  const wireInput: InvocationInput = {
    prompt: 'Summarize this document',
    text: 'fixture text',
    artifacts: [{ artifactId: '00000000-0000-4000-8000-000000000001' }],
    outputSchema: { type: 'object' },
  };
  const sdkInput: ConnectorInvokeInput = wireInput;

  expect(sdkInput).toEqual(wireInput);
});
