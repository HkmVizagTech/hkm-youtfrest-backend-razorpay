const Feedback = require('../models/Feedback.model');
const Candidate = require('../models/Candidate.model');

/** 10 digits, Indian mobile, with or without the 91 prefix. */
const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
};

const clampRating = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : undefined;
};

const FeedbackController = {
  // ── Public: submit feedback ────────────────────────────────────────────────
  // No auth by design — this is reached by scanning a QR code at the exit, and
  // anything that asks a student to log in at that moment gets abandoned.
  //
  // Rate limiting is deliberately light: a duplicate from the same phone within
  // DEDUPE_MINUTES is treated as a double-tap and returns success rather than
  // an error, so a student who taps twice on a slow connection is not told
  // something went wrong.
  submit: async (req, res) => {
    try {
      const b = req.body || {};

      const overallRating = clampRating(b.overallRating);
      if (!overallRating) {
        return res.status(400).json({ status: 'error', message: 'Please give an overall rating.' });
      }

      const phone = normalizePhone(b.whatsappNumber);

      // Double-tap guard.
      if (phone) {
        const recent = await Feedback.findOne({
          whatsappNumber: phone,
          createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
        });
        if (recent) {
          return res.json({ status: 'success', message: 'Thank you — your feedback is already recorded.', duplicate: true });
        }
      }

      // Link to a registration if we can, but never block on it.
      let candidateId, college = b.college, name = b.name;
      if (phone) {
        const candidate = await Candidate.findOne({ whatsappNumber: phone }).select('_id name college');
        if (candidate) {
          candidateId = candidate._id;
          college = college || candidate.college;
          name = name || candidate.name;
        }
      }

      const doc = await Feedback.create({
        overallRating,
        contentRating: clampRating(b.contentRating),
        organizationRating: clampRating(b.organizationRating),
        venueRating: clampRating(b.venueRating),
        foodRating: clampRating(b.foodRating),
        wouldRecommend: typeof b.wouldRecommend === 'boolean' ? b.wouldRecommend : undefined,
        wantsFutureEvents: typeof b.wantsFutureEvents === 'boolean' ? b.wantsFutureEvents : undefined,
        likedMost: b.likedMost,
        improvements: b.improvements,
        name,
        whatsappNumber: phone || undefined,
        candidateId,
        college,
        source: b.source || 'exit-qr',
      });

      res.json({ status: 'success', message: 'Thank you for your feedback!', id: doc._id });
    } catch (err) {
      console.error('feedback submit error:', err.message);
      res.status(500).json({ status: 'error', message: 'Could not save your feedback. Please try again.' });
    }
  },

  // ── Admin: summary ─────────────────────────────────────────────────────────
  summary: async (req, res) => {
    try {
      const total = await Feedback.countDocuments();

      const avg = await Feedback.aggregate([
        {
          $group: {
            _id: null,
            overall: { $avg: '$overallRating' },
            content: { $avg: '$contentRating' },
            organization: { $avg: '$organizationRating' },
            venue: { $avg: '$venueRating' },
            food: { $avg: '$foodRating' },
            recommend: { $avg: { $cond: ['$wouldRecommend', 1, 0] } },
            future: { $avg: { $cond: ['$wantsFutureEvents', 1, 0] } },
          },
        },
      ]);

      // Distribution of the overall rating, 1..5.
      const distRows = await Feedback.aggregate([
        { $group: { _id: '$overallRating', n: { $sum: 1 } } },
      ]);
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of distRows) distribution[r._id] = r.n;

      const byCollege = await Feedback.aggregate([
        { $match: { college: { $nin: [null, ''] } } },
        { $group: { _id: '$college', n: { $sum: 1 }, avg: { $avg: '$overallRating' } } },
        { $sort: { n: -1 } },
        { $limit: 20 },
      ]);

      const a = avg[0] || {};
      const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

      res.json({
        status: 'success',
        total,
        linkedToRegistration: await Feedback.countDocuments({ candidateId: { $exists: true, $ne: null } }),
        averages: {
          overall: round(a.overall),
          content: round(a.content),
          organization: round(a.organization),
          venue: round(a.venue),
          food: round(a.food),
        },
        recommendPct: a.recommend == null ? null : Math.round(a.recommend * 100),
        futureEventsPct: a.future == null ? null : Math.round(a.future * 100),
        distribution,
        byCollege: byCollege.map(c => ({ college: c._id, count: c.n, avg: round(c.avg) })),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: list responses (newest first, paged) ────────────────────────────
  list: async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const skip = Number(req.query.skip) || 0;
      const match = {};
      if (req.query.rating) match.overallRating = Number(req.query.rating);
      // Only responses that actually wrote something, when asked for.
      if (req.query.withComments === 'true') {
        match.$or = [
          { likedMost: { $nin: [null, ''] } },
          { improvements: { $nin: [null, ''] } },
        ];
      }

      const [rows, count] = await Promise.all([
        Feedback.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Feedback.countDocuments(match),
      ]);

      res.json({ status: 'success', count, skip, limit, feedback: rows });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },
};

module.exports = { FeedbackController };
