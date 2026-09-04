const mongoose = require('mongoose');

/**
 * Every WhatsApp message we send, and what actually happened to it.
 *
 * Why this exists: Flaxxa's send API returns only `{status:"success",
 * message_id, message_wamid}`. A wamid means Meta ACCEPTED the message — not
 * that it was delivered. On 4 Sep 2026 the number hit a Meta spam rate limit
 * and 165 slot-change messages were accepted and then silently dropped; every
 * layer of our code reported success because acceptance is all the API shows.
 *
 * There is no status endpoint on Flaxxa (all the obvious paths 404), so the
 * only way to learn the truth is a delivery callback. This collection is what
 * that callback writes into: we record the wamid at send time, and the webhook
 * fills in what became of it.
 */
const messageLogSchema = new mongoose.Schema({
  provider: { type: String, default: 'flaxxa', index: true },
  wamid: { type: String, index: true },
  messageId: { type: String },

  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', index: true },
  name: { type: String },
  phone: { type: String, index: true },

  // What we sent: 'slotChange' | 'reminder:oneDay' | 'certificate' | ...
  kind: { type: String, index: true },
  template: { type: String },

  // 'accepted' at send time; the webhook moves it to sent/delivered/read/failed.
  status: { type: String, default: 'accepted', index: true },
  error: { type: String },

  sentAt: { type: Date, default: Date.now },
  statusAt: { type: Date },
  // 'phone' when the callback had to be matched by recipient rather than id
  matchedBy: { type: String },

  // Flaxxa's callback shape is not documented anywhere we can see, so keep the
  // raw body of the first callback for each message. Once we have real samples
  // the parser can be tightened; until then nothing is lost.
  rawCallback: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

module.exports = mongoose.model('MessageLog', messageLogSchema);
