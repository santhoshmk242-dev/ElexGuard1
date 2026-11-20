'use strict';
const router = require('express').Router();
const c = require('../controllers/voterController');
const v = require('../utils/validators');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { voteLimiter } = require('../middleware/security');

router.use(authenticate, authorize('voter'));

router.get('/dashboard', c.dashboard);
router.get('/elections', c.listElections);
router.get('/elections/:id', validate(v.idParam, 'params'), c.getElection);
router.get('/elections/:id/eligibility', validate(v.idParam, 'params'), c.eligibility);
router.post('/elections/:id/ballot-access', voteLimiter, validate(v.idParam, 'params'), c.ballotAccess);
router.post('/elections/:id/vote', voteLimiter, validate(v.idParam, 'params'), validate(v.vote.submit), c.castVote);
router.get('/candidates/:id', validate(v.idParam, 'params'), c.getCandidate);
router.get('/history', c.history);

module.exports = router;
