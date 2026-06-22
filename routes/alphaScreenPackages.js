'use strict'

const express = require('express')
const { listPublicAlphaScreenPackages } = require('../src/lib/alphaScreenPackages')

const router = express.Router()

router.get('/packages', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  return res.json({
    packages: listPublicAlphaScreenPackages(),
    request_id: req.request_id || null
  })
})

module.exports = router
