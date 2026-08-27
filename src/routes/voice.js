// Owner: Collections (B). Africa's Talking requests this when the outbound
// escalation call connects. Respond with dial-plan XML for what to speak.

const express = require('express');
const router = express.Router();
const cfg = require('../config');

router.post('/', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Hello. This is an automated payment reminder from ${cfg.businessName}. Your invoice is overdue. Please pay today using the M-Pesa prompt we sent you. Thank you.</Say>
</Response>`);
});

module.exports = router;
