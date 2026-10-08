'use strict';

const express = require('express');
const { requireSuperAdmin, sendBoundedError } = require('./adminInterviewReliability');
const { createQaSyntheticInterviewService } = require('../src/lib/qaSyntheticInterviews');

function createAdminSyntheticInterviewsRouter({ service } = {}) {
  const active = service || createQaSyntheticInterviewService({
    execute: (options) => require('../src/lib/qaSyntheticInterviewRunner').runSyntheticInterview(options),
  });
  const router = express.Router();
  router.use(requireSuperAdmin, express.json({ limit: '2kb' }));
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const handle = (handler) => async (req, res) => {
    try { return await handler(req, res); }
    catch (error) { return sendBoundedError(res, error, req.request_id); }
  };
  router.get('/', handle((_req, res) => res.json(active.list())));
  router.post('/runs', handle((req, res) => res.status(202).json(active.start(req.body))));
  router.get('/runs/:id', handle((req, res) => res.json(active.get(req.params.id))));
  router.post('/runs/:id/cancel', handle((req, res) => res.json(active.cancel(req.params.id))));
  router.get('/runs/:id/audio', handle((req, res) => res.type('audio/webm').send(active.audio(req.params.id))));
  return router;
}

module.exports = { createAdminSyntheticInterviewsRouter };
