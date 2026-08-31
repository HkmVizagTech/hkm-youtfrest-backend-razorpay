require('dotenv').config();
const mongoose = require('mongoose');
const Candidate = require('../src/models/Candidate.model');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 15000,
      connectTimeoutMS: 8000,
    });
    console.log('Connected to MongoDB\n');

    // Find paid candidates that have razorpayPaymentData
    const candidates = await Candidate.find({
      paymentStatus: 'Paid',
      razorpayPaymentData: { $exists: true, $ne: null }
    }).select('name paymentId paymentMethod razorpayPaymentData').limit(5);

    if (!candidates.length) {
      console.log('No candidates with razorpayPaymentData found.');
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log(`Found ${candidates.length} candidates with razorpayPaymentData:\n`);

    for (const c of candidates) {
      console.log(`═══ ${c.name} ═══`);
      console.log(`  paymentId: ${c.paymentId}`);
      console.log(`  paymentMethod: ${c.paymentMethod}`);
      console.log(`  razorpayPaymentData keys: ${Object.keys(c.razorpayPaymentData || {}).join(', ')}`);

      // Deep inspect the raw data
      const raw = c.razorpayPaymentData;
      if (raw) {
        console.log(`  id: ${raw.id}`);
        console.log(`  method: ${raw.method}`);
        console.log(`  amount: ${raw.amount}`);
        console.log(`  status: ${raw.status}`);
        console.log(`  created_at: ${raw.created_at}`);

        // Check for UPI-specific fields
        if (raw.upi) {
          console.log(`  upi: ${JSON.stringify(raw.upi, null, 2)}`);
        }
        if (raw.bank) {
          console.log(`  bank: ${raw.bank}`);
        }
        if (raw.vpa) {
          console.log(`  vpa: ${raw.vpa}`);
        }
        if (raw.acquirer_data) {
          console.log(`  acquirer_data: ${JSON.stringify(raw.acquirer_data, null, 2)}`);
        }
        if (raw.notes) {
          console.log(`  notes: ${JSON.stringify(raw.notes, null, 2)}`);
        }

        // Print ALL top-level keys so we don't miss anything
        console.log(`  ALL keys: ${JSON.stringify(Object.keys(raw))}`);
      }
      console.log('');
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
