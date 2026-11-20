'use strict';
const router = require('express').Router();
const c = require('../controllers/publicController');
const v = require('../utils/validators');
const validate = require('../middleware/validate');
const { authLimiter } = require('../middleware/security');

router.get('/stats', c.stats);
router.get('/elections', c.listElections);
router.get('/elections/:id', validate(v.idParam, 'params'), c.getElection);
router.get('/candidates', c.listCandidates);
router.get('/candidates/:id', validate(v.idParam, 'params'), c.getCandidate);
router.get('/constituencies', c.listConstituencies);
router.get('/notices', c.listNotices);
router.get('/results', c.listResults);
router.get('/results/:id', validate(v.idParam, 'params'), c.getResults);
router.get('/dfa', c.dfaDefinition);
router.post('/contact', authLimiter, validate(v.contact), c.contact);

module.exports = router;
