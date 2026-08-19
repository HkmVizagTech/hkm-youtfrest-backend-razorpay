const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');

const admins = [
  { name: 'Sarvajita Rama Prabhu', email: 'sjrd@hkmvizag.org', password: 'SRJD@111', role: 'admin' },
];

const seedAdmins = async () => {
  for (const admin of admins) {
    const existing = await userModel.findOne({ email: admin.email });
    if (existing) {
      const match = await bcrypt.compare(admin.password, existing.password);
      if (existing.role !== admin.role || existing.name !== admin.name || !match) {
        existing.name = admin.name;
        existing.role = admin.role;
        if (!match) existing.password = await bcrypt.hash(admin.password, 10);
        await existing.save();
        console.log(`✅ Synced admin: ${admin.email}`);
      }
    } else {
      const hashed = await bcrypt.hash(admin.password, 10);
      await userModel.create({ name: admin.name, email: admin.email, password: hashed, role: admin.role });
      console.log(`✅ Created admin: ${admin.email}`);
    }
  }
};

module.exports = { seedAdmins, admins };
