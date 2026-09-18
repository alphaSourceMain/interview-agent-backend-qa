'use strict'

const { supabaseAdmin } = require('../lib/supabaseClient')

function createRequireSalesRep(options = {}) {
  const db = options.db || supabaseAdmin
  return async function requireSalesRep(req, res, next) {
    const userId = String(req.user?.id || '').trim()
    if (!userId) {
      return res.status(401).json({
        error: 'authentication_required',
        code: 'authentication_required',
        detail: 'Sign in to continue.'
      })
    }

    try {
      const { data, error } = await db
        .from('sales_reps')
        .select('user_id,email,display_name,active')
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle()
      if (error) {
        console.error('[sales/auth] sales_rep_lookup_failed', {
          request_id: req.request_id || null,
          code: error.code || null
        })
        return res.status(503).json({
          error: 'sales_access_unavailable',
          code: 'sales_access_unavailable',
          detail: 'Sales access could not be verified.',
          request_id: req.request_id || null
        })
      }
      if (!data) {
        return res.status(403).json({
          error: 'sales_access_denied',
          code: 'sales_access_denied',
          detail: 'Sales access is not enabled for this account.',
          request_id: req.request_id || null
        })
      }
      req.salesRep = {
        user_id: data.user_id,
        email: data.email,
        display_name: data.display_name
      }
      return next()
    } catch (error) {
      console.error('[sales/auth] unexpected', {
        request_id: req.request_id || null,
        error: error?.message || String(error)
      })
      return res.status(503).json({
        error: 'sales_access_unavailable',
        code: 'sales_access_unavailable',
        detail: 'Sales access could not be verified.',
        request_id: req.request_id || null
      })
    }
  }
}

module.exports = { createRequireSalesRep }
