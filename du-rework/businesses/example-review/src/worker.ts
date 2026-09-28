import { BusinessManifest } from '@du/contracts';
import {
  BusinessDefinition,
  QueueConsumer,
  TaskHandler,
  WorkerConfig,
  WorkerHandle,
  defineBusiness,
  startWorker,
} from '@du/worker-sdk';
import { exampleReviewManifest } from './manifest';
import { mainReviewHandler, itemReviewHandler } from './review';

export const exampleReviewHandlers: Record<string, TaskHandler> = {
  review: mainReviewHandler,
  'review-item': itemReviewHandler,
  root: mainReviewHandler,
};

export const exampleReviewBusiness: BusinessDefinition = defineBusiness(
  exampleReviewManifest,
  exampleReviewHandlers
);

export interface ExampleReviewWorkerConfig extends WorkerConfig {
  consumer?: QueueConsumer;
  manifest?: BusinessManifest;
}

export async function startExampleReviewWorker(
  config: ExampleReviewWorkerConfig
): Promise<WorkerHandle> {
  const definition = config.manifest
    ? defineBusiness(config.manifest, exampleReviewHandlers)
    : exampleReviewBusiness;
  return startWorker(definition, config);
}
