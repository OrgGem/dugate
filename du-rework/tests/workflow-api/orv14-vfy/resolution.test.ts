import { readMigrationReadiness } from '../../../orchestrator/services/orchestrator/src/modules/legacy-migration/readiness';
import { createApp } from '../../../orchestrator/services/orchestrator/src/server';

test('the frozen source additions resolve through the independent Node24/Jest harness', () => {
  expect(readMigrationReadiness).toEqual(expect.any(Function));
  expect(createApp).toEqual(expect.any(Function));
});
