'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const calls = new Map();

// The gateway connector sends multipart data; this stub returns the OpenAI chat
// completion shape so responseContentPath and usage parsing run in the worker.
router.post('/ext/openai-e2e/:runId', upload.any(), (req, res) => {
  const runId = req.params.runId;
  const query = String(req.body?.query || '');
  const files = (req.files || []).map((file) => file.originalname);
  const record = { query, files, model: String(req.body?.model || '') };
  calls.set(runId, [...(calls.get(runId) || []), record]);

  res.json({
    id: `chatcmpl-mock-${runId}`,
    object: 'chat.completion',
    model: 'mock-openai-e2e',
    choices: [{ index: 0, message: { role: 'assistant', content: `mock-openai:${runId}:${query}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
});

router.get('/__test/openai-e2e/:runId', (req, res) => {
  res.json({ calls: calls.get(req.params.runId) || [] });
});

router.delete('/__test/openai-e2e/:runId', (req, res) => {
  calls.delete(req.params.runId);
  res.status(204).end();
});

module.exports = router;
