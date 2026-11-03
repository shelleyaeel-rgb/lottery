import { parentPort, workerData } from 'node:worker_threads';
import { trainModels } from './models.mjs';

try { parentPort.postMessage({ result: trainModels(workerData.draws, { now: workerData.now }) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
