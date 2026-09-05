const mongoose = require('mongoose');

/**
 * Feedback from Krishna Pulse attendees.
 *
 * Collected from a QR code at the venue exit, so the form has to be answerable
 * in under a minute while someone is standing up to leave: five taps and two
 * optional text boxes. Everything except the overall rating is optional — a
 * partial response is worth far more than an abandoned one.
 *
 * Phone number is optional and only used to link the response back to a
 * registration. It is NOT required, because demanding it at the exit is the
 * fastest way to halve your response rate.
 */
const feedbackSchema = new mongoose.Schema({
  // The only required field.
  overallRating: { type: Number, required: true, min: 1, max: 5, index: true },

  // Optional dimension ratings.
  contentRating: { type: Number, min: 1, max: 5 },
  organizationRating: { type: Number, min: 1, max: 5 },
  venueRating: { type: Number, min: 1, max: 5 },
  foodRating: { type: Number, min: 1, max: 5 },

  wouldRecommend: { type: Boolean },
  wantsFutureEvents: { type: Boolean },

  likedMost: { type: String, maxlength: 2000, trim: true },
  improvements: { type: String, maxlength: 2000, trim: true },

  // Optional identity. candidateId is filled in server-side when the phone
  // matches a registration, so responses can be cross-referenced with
  // attendance without asking the student to prove who they are.
  name: { type: String, maxlength: 120, trim: true },
  whatsappNumber: { type: String, index: true },
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', index: true },
  college: { type: String, maxlength: 200, trim: true },

  // 'exit-qr' today; 'whatsapp' if we send a link later.
  source: { type: String, default: 'exit-qr', index: true },
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
