const mongoose = require('mongoose');
require('dotenv').config();
const { seedCollegeAdmins } = require('../src/utils/seedCollegeAdmins');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI env var is not set.');
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    await seedCollegeAdmins();
    console.log('✅ Seed complete');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
