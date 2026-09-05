const express = require('express');
const { FeedbackController } = require('../controllers/Feedback.controller');
const { authenticate } = require('../middlewares/auth.middleware');

const FeedbackRouter = express.Router();

// Public — reached by scanning the QR code at the venue exit.
FeedbackRouter.post('/', FeedbackController.submit);

// Admin only.
FeedbackRouter.get('/summary', authenticate(['admin']), FeedbackController.summary);
FeedbackRouter.get('/list', authenticate(['admin']), FeedbackController.list);

module.exports = { FeedbackRouter };
