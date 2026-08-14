const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');

const collegeAdmins = [
  { name: 'suresh', email: 'pillisureshreddy@gmail.com', password: 'suresh@123', role: 'collegeadmin' },
  { name: 'arun', email: 'arun.99125@gmail.com', password: 'arun@123', role: 'collegeadmin' },
];

const seedCollegeAdmins = async () => {
  for (const admin of collegeAdmins) {
    const existing = await userModel.findOne({ email: admin.email });
    if (existing) {
      const match = await bcrypt.compare(admin.password, existing.password);
      if (existing.role !== admin.role || existing.name !== admin.name || !match) {
        existing.name = admin.name;
        existing.role = admin.role;
        if (!match) existing.password = await bcrypt.hash(admin.password, 10);
        await existing.save();
        console.log(`✅ Synced college admin: ${admin.email}`);
      }
    } else {
      const hashed = await bcrypt.hash(admin.password, 10);
      await userModel.create({ name: admin.name, email: admin.email, password: hashed, role: admin.role });
      console.log(`✅ Created college admin: ${admin.email}`);
    }
  }
};

module.exports = { seedCollegeAdmins, collegeAdmins };
