'use strict';

const express = require('express');
const { reconcileSalesWonDeliveries } = require('../src/lib/salesIntegrations');
const { recordGhlSyncEvent } = require('../src/lib/ghlSalesIntegration');
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
      const result = await applySalesTeamMember({
        db,
        memberId: req.params.memberId,
        replaceTeamMemberId: req.body?.replace_team_member_id || null,
        actorId: req.user?.id || null,
      });
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

  router.post('/ghl-sales-sync/reconcile', async (req, res) => {
    try {
      const summary = await reconcileSalesWonDeliveries({ db, limit: 100, logger: console });
      await recordGhlSyncEvent(db, {
        direction: 'admin',
        eventType: 'reconcile_requested',
        idempotencyKey: `admin:reconcile:${req.request_id || Date.now()}`,
        status: 'completed',
        safeMetadata: {
          actor_user_id: req.user?.id || null,
          scanned: summary.scanned,
          enqueued: summary.enqueued,
          failed: summary.failed,
        },
      });
      return res.json({ ok: true, summary });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/ghl-sales-sync/:deliveryId/retry', async (req, res) => {
    try {
      const deliveryId = String(req.params.deliveryId || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId)) {
        throw Object.assign(new Error('Choose a valid GHL delivery.'), { status: 400, code: 'ghl_delivery_id_invalid', detail: 'Choose a valid GHL delivery.' });
      }
      const { data: delivery, error: lookupError } = await db.from('sales_integration_deliveries')
        .select('id,purchase_intent_id,status')
        .eq('id', deliveryId)
        .eq('integration', 'ghl')
        .maybeSingle();
      if (lookupError) throw Object.assign(new Error('GHL delivery lookup failed'), { cause: lookupError });
      if (!delivery) throw Object.assign(new Error('GHL delivery not found.'), { status: 404, code: 'ghl_delivery_not_found', detail: 'GHL delivery not found.' });
      if (delivery.status === 'delivered') {
        throw Object.assign(new Error('This GHL delivery already completed.'), { status: 409, code: 'ghl_delivery_already_completed', detail: 'This GHL delivery already completed.' });
      }
      if (delivery.status !== 'failed') {
        throw Object.assign(new Error('This GHL delivery is already pending or processing.'), { status: 409, code: 'ghl_delivery_retry_not_available', detail: 'This GHL delivery is already pending or processing.' });
      }
      const now = new Date().toISOString();
      const { error: resetError } = await db.from('sales_integration_deliveries').update({
        status: 'retry',
        next_attempt_at: now,
        locked_at: null,
        lock_token: null,
        last_error: null,
        manual_review_required: false,
        updated_at: now,
      }).eq('id', delivery.id).eq('integration', 'ghl');
      if (resetError) throw Object.assign(new Error('GHL delivery retry failed'), { cause: resetError });
      const { error: bindingError } = await db.from('ghl_sales_deal_bindings').update({
        status: 'won_pending',
        last_error_code: null,
        last_error_detail: null,
        manual_review_required: false,
        updated_at: now,
      }).eq('purchase_intent_id', delivery.purchase_intent_id);
      if (bindingError) throw Object.assign(new Error('GHL binding retry failed'), { cause: bindingError });
      await recordGhlSyncEvent(db, {
        purchaseIntentId: delivery.purchase_intent_id,
        direction: 'admin',
        eventType: 'delivery_retry_requested',
        idempotencyKey: `admin:retry:${delivery.id}:${req.request_id || Date.now()}`,
        status: 'completed',
        safeMetadata: { delivery_id: delivery.id, actor_user_id: req.user?.id || null },
      });
      return res.json({ ok: true, delivery_id: delivery.id });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  return router;
}

module.exports = { createAdminSalesTeamRouter };
