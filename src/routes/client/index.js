'use strict';

// The client-scoped routes that app.js registered before the shared router
// mounts. They are mounted at the root because they span /auth and /clients
// rather than one prefix.

const express = require('express');

const router = express.Router();

router.use(require('./auth'));
router.use(require('./clients'));
router.use(require('./entities'));
router.use(require('./billing'));
router.use(require('./roleCheckout'));

module.exports = router;
