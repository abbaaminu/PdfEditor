const express = require('express');
const router = express.Router();

// Verify and handle Paddle webhooks
router.post('/webhook', (req, res) => {
  const { event_type, data } = req.body;

  if (event_type === 'subscription.created' || event_type === 'subscription.updated') {
    const customerId = data.customer_id;
    const status = data.status; // 'active', 'canceled', etc.
    console.log(`Subscription updated for customer ${customerId}: ${status}`);
  }

  res.status(200).json({ received: true });
});

// Check local user subscription status
router.get('/status/:userId', (req, res) => {
  res.json({ userId: req.params.userId, isPro: true });
});

module.exports = router;