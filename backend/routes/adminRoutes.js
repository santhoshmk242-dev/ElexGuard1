'use strict';
const router = require('express').Router();
const v = require('../utils/validators');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { candidatePhoto } = require('../middleware/upload');
const elections = require('../controllers/adminElectionController');
const catalog = require('../controllers/adminCatalogController');
const voters = require('../controllers/adminVoterController');
const monitor = require('../controllers/adminMonitoringController');

router.use(authenticate, authorize('admin'));
const id = validate(v.idParam, 'params');

router.get('/dashboard', monitor.dashboard);

// Elections & lifecycle
router.get('/elections', elections.list);
router.post('/elections', validate(v.election.create), elections.create);
router.get('/elections/:id', id, elections.get);
router.put('/elections/:id', id, validate(v.election.update), elections.update);
router.delete('/elections/:id', id, elections.remove);
router.patch('/elections/:id/duration', id, validate(v.election.duration), elections.changeDuration);
router.post('/elections/:id/schedule', id, elections.schedule);
router.post('/elections/:id/start', id, elections.start);
router.post('/elections/:id/pause', id, elections.pause);
router.post('/elections/:id/resume', id, elections.resume);
router.post('/elections/:id/end', id, elections.end);
router.post('/elections/:id/publish', id, elections.publish);
router.get('/elections/:id/results', id, elections.results);
router.get('/elections/:id/report', id, monitor.reportJson);
router.get('/elections/:id/report.csv', id, monitor.reportCsv);
router.get('/elections/:id/report.pdf', id, monitor.reportPdf);

// Candidates (multipart: optional "photo" file)
router.get('/candidates', catalog.listCandidates);
router.post('/candidates', candidatePhoto, validate(v.candidate.create), catalog.createCandidate);
router.get('/candidates/:id', id, catalog.getCandidate);
router.put('/candidates/:id', id, candidatePhoto, validate(v.candidate.update), catalog.updateCandidate);
router.delete('/candidates/:id', id, catalog.removeCandidate);

// Constituencies
router.get('/constituencies', catalog.listConstituencies);
router.post('/constituencies', validate(v.constituency.create), catalog.createConstituency);
router.put('/constituencies/:id', id, validate(v.constituency.update), catalog.updateConstituency);
router.delete('/constituencies/:id', id, catalog.removeConstituency);

// Voters
router.get('/voters', voters.list);
router.get('/voters/:id', id, voters.get);
router.post('/voters/:id/approve', id, voters.approve);
router.post('/voters/:id/reject', id, validate(v.voter.reject), voters.reject);

// Notices & contact inbox
router.get('/notices', catalog.listNotices);
router.post('/notices', validate(v.notice), catalog.createNotice);
router.delete('/notices/:id', id, catalog.deleteNotice);
router.get('/messages', catalog.listMessages);
router.post('/messages/:id/handled', id, catalog.handleMessage);

// Monitoring
router.get('/audit-logs', monitor.auditLogs);
router.get('/security-events', monitor.securityEvents);

module.exports = router;
