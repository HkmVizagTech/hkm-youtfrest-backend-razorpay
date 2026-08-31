require('dotenv').config();
const mongoose = require('mongoose');
const Candidate = require('../src/models/Candidate.model');

const extractRrn = (data) => {
  if (!data) return undefined;
  if (data.rrn) return data.rrn;
  if (data.acquirer_data) {
    if (data.acquirer_data.rrn) return data.acquirer_data.rrn;
    if (data.acquirer_data.bank_transaction_id) return data.acquirer_data.bank_transaction_id;
  }
  return undefined;
};

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 10000,
    });
    console.log('Connected to MongoDB\n');

    const candidates = await Candidate.find({
      paymentStatus: 'Paid',
      $or: [
        { rrn: { $exists: false } },
        { rrn: null },
        { rrn: '' },
      ],
    }).select('name paymentId razorpayPaymentData rrn');

    console.log(`Found ${candidates.length} paid candidates missing RRN\n`);

    let updated = 0;
    let withData = 0;

    for (const c of candidates) {
      const rrn = extractRrn(c.razorpayPaymentData);
      if (!rrn) {
        console.log(`SKIP  ${c.name} — no razorpayPaymentData / no RRN (paymentId: ${c.paymentId})`);
        continue;
      }
      c.rrn = rrn;
      await c.save();
      updated++;
      withData++;
      console.log(`DONE  ${c.name} -> ${rrn}`);
    }

    console.log(`\nUpdated: ${updated}, with stored razorpayPaymentData inspected: ${withData}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
