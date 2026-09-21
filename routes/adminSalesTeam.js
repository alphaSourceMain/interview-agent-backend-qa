'use strict';

const express = require('express');
const {
  applySalesTeamMember,
  deactivateSalesTeamMember,
  loadAdminSalesTeam,
  reactivateSalesTeamMember,
  rotateSalesVoiceToken,
  safeSalesTeamError,
  saveSalesLineSetup,
  saveSalesTeamMember,
  syncSalesTeamMember,
} = require('../src/lib/adminSalesTeamService');

function createAdminSalesTeamRouter({ db } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  function respondError(req, res, error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) {
      console.error('[admin-sales-team] request_failed', {
        request_id: req.request_id || null,
        code: error?.cause?.code || error?.code || null,
      });
    }
    return res.status(status).json(safeSalesTeamError(error, req.request_id || null));
  }

  router.get('/', async (req, res) => {
    try {
      return res.json(await loadAdminSalesTeam({ db }));
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members', async (req, res) => {
    try {
      const item = await saveSalesTeamMember({ db, body: req.body || {}, actorId: req.user?.id || null });
      return res.status(201).json({ ok: true, item });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.patch('/members/:memberId', async (req, res) => {
    try {
      const item = await saveSalesTeamMember({ db, memberId: req.params.memberId, body: req.body || {}, actorId: req.user?.id || null });
      return res.json({ ok: true, item });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members/:memberId/apply', async (req, res) => {
    try {
      const result = await applySalesTeamMember({ db, memberId: req.params.memberId, actorId: req.user?.id || null });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members/:memberId/reactivate', async (req, res) => {
    try {
      const item = await reactivateSalesTeamMember({ db, memberId: req.params.memberId, actorId: req.user?.id || null });
      return res.json({ ok: true, item });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members/:memberId/deactivate', async (req, res) => {
    try {
      const item = await deactivateSalesTeamMember({ db, memberId: req.params.memberId, actorId: req.user?.id || null });
      return res.json({ ok: true, item });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members/:memberId/rotate-agent-token', async (req, res) => {
    try {
      const result = await rotateSalesVoiceToken({ db, memberId: req.params.memberId, phoneId: req.body?.phone_id || null, actorId: req.user?.id || null });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, ...result });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members/:memberId/sync', async (req, res) => {
    try {
      const result = await syncSalesTeamMember({ db, memberId: req.params.memberId });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.patch('/lines/:phoneId', async (req, res) => {
    try {
      const phone = await saveSalesLineSetup({ db, phoneId: req.params.phoneId, body: req.body || {}, actorId: req.user?.id || null });
      return res.json({ ok: true, phone });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  return router;
}

module.exports = { createAdminSalesTeamRouter };
