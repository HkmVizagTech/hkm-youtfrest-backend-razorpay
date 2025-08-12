const mongoose = require('mongoose');

const candidateSchema = new mongoose.Schema({
  serialNo: { type: Number },
  name: { type: String },
  gender: { type: String, enum: ['Male', 'Female', 'Other'] },
  college: { type: String },
  course: { type: String },
  companyName: { type: String },
  collegeOrWorking: { type: String, enum: ['College', 'Working'] },
  email: { type: String },
  year: { type: String },
  dob: { type: Date },
  registrationDate: { type: Date, default: Date.now },
  whatsappNumber: { type: String, required: true },
  slot: { type: String },


  paymentStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Failed'],
    default: 'Pending',
  },
  paymentId: { type: String },
  orderId: { type: String },
  paymentAmount: { type: Number, required: true },
  paymentDate: { type: Date },
  paymentMethod: { type: String },
  receipt: { type: String },

  remindersSent: {
    threeDay: { type: Boolean, default: false },
    twoDay: { type: Boolean, default: false },
    oneDay: { type: Boolean, default: false },
    twoHour: { type: Boolean, default: false },
  },

  attendance: { type: Boolean, default: false },

  adminAttendance: { type: Boolean, default: false },
  adminAttendanceDate: { type: Date },
  attendanceToken: { type: String }, 


  paymentUpdatedBy: { type: String, enum: ['manual', 'webhook'], default: 'manual' },
  razorpayPaymentData: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

const Candidate = mongoose.model('Candidate', candidateSchema);

module.exports =  Candidate