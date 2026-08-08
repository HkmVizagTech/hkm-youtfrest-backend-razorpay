const mongoose = require('mongoose');

const CollegeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'College name is required'],
      trim: true,
      unique: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('College', CollegeSchema);
