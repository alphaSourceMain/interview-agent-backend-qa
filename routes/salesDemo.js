'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { DEMO_CLIENT_ID, isQa, uuid } = require('../src/lib/salesDemo');
const { people } = require('../demo/northstar');
const { buildWorkspace } = require('../demo/workspace');

const router = express.Router();
router.use(requireAuth, withClientScope);
router.get('/workspace', (req,res) => {
  if (!isQa() || req.query.client_id !== DEMO_CLIENT_ID) return res.status(403).end();
  const manager = req.isSalesDemo === true && req.isGlobalAdmin !== true && req.clientIds?.length === 1 && req.clientIds[0] === DEMO_CLIENT_ID && (req.memberships || []).some(m => m.client_id === DEMO_CLIENT_ID && m.role === 'manager');
  // Admin status comes from verified Auth and the active admins table, never request metadata.
  const adminPreview = req.isGlobalAdmin === true && !req.isSalesDemo;
  if (!manager && !adminPreview) return res.status(403).end();
  res.set('Cache-Control','private, no-store');
  return res.json(buildWorkspace());
});
router.use((req, res, next) => {
  const membership = (req.memberships || []).find(m => m.client_id === DEMO_CLIENT_ID && m.role === 'manager');
  if (!isQa() || !req.isSalesDemo || !membership || req.clientIds?.length !== 1) return res.status(403).json({ error: 'demo_access_denied' });
  res.set('Cache-Control','private, no-store');
  next();
});
router.post('/reset', async (req, res) => {
  if (req.body?.confirmation !== 'RESTORE SHARED DEMO') return res.status(400).json({ error: 'shared_reset_confirmation_required' });
  const { data, error } = await supabaseAdmin.rpc('sales_demo_control',{ p_operation:'reset' });
  if (error) return res.status(409).json({ error: 'demo_reset_not_safe', detail:'The demo could not be safely restored. Please contact your administrator.' });
  return res.json(data);
});
router.get('/:kind/:id', (req,res) => {
  if (!['resumes','reports'].includes(req.params.kind)) return res.status(404).json({ error: 'demo_document_not_found' });
  const person = people.find(p => uuid(p.n) === req.params.id);
  if (!person) return res.status(404).json({ error: 'demo_resume_not_found' });
  const file = path.join(__dirname,'../demo',req.params.kind,`${uuid(person.n)}.pdf`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'demo_resume_not_found' });
  res.type('application/pdf').set('Content-Disposition',`inline; filename="${person.name.toLowerCase().replace(/ /g,'-')}-synthetic-resume.pdf"`);
  return res.sendFile(file);
});
module.exports=router;
