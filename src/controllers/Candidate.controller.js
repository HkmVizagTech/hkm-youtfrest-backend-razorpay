const Candidate = require('../models/Candidate.model');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const sendWhatsappGupshup = require('../utils/sendWhatsappGupshup');
require('dotenv').config();
const gupshup = require('@api/gupshup');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const CandidateController = {

  createOrder: async (req, res) => {
    const { amount, formData } = req.body;  
    const receipt = `receipt_${Date.now()}`;
    const options = { amount, currency: "INR", receipt };

    try {
      const order = await razorpay.orders.create(options);
      const normalizedNumber = "91" + formData.whatsappNumber;
      const candidate = new Candidate({
        serialNo: formData.serialNo,
        name: formData.name.trim(),
        gender: formData.gender,
        college: formData.college,
        course: formData.course,
        year: formData.year,
        dob: new Date(formData.dob),
        registrationDate: new Date(),
        collegeOrWorking: formData.collegeOrWorking,
        companyName: formData.companyName,
        whatsappNumber: normalizedNumber,
        slot: formData.slot,
        paymentStatus: "Pending",
        orderId: order.id,
        paymentAmount: parseFloat(amount) / 100,
        receipt: receipt,
        email: formData.email,
      });
      await candidate.save();
      return res.json(order);
    } catch (err) {
      console.error("Error creating order and saving candidate:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },

  verifyPayment: async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generated_signature = hmac.digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ status: "fail", message: "Payment verification failed" });
    }

    try {
      const candidate = await Candidate.findOne({ orderId: razorpay_order_id });

      if (!candidate) {
        return res.status(404).json({ status: "fail", message: "Candidate not found" });
      }

      if (candidate.paymentStatus === "Paid") {
        return res.json({ message: "Already Registered", candidate });
      }

      candidate.paymentId = razorpay_payment_id;
      candidate.paymentDate = new Date();
      candidate.paymentStatus = "Paid";
      candidate.paymentMethod = "Online";
      candidate.paymentUpdatedBy = "manual";
      await candidate.save();

     
      if (!candidate.whatsappNumber) {
        console.error("Cannot send WhatsApp: candidate.whatsappNumber is missing for", candidate._id);
      } else {
        await sendWhatsappGupshup(candidate);
      }

      return res.json({ message: "success", candidate });

    } catch (err) {
      console.error("Error verifying payment:", err);
      return res.status(500).json({ status: "error", message: "Registration failed" });
    }
  },

  webhook: async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    const expectedSignature = crypto.createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).send('Invalid signature');
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === "payment.captured") {
      const payment = payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;

      try {
        let candidate = await Candidate.findOne({ orderId: orderId });
        if (candidate && candidate.paymentStatus !== "Paid") {
          candidate.paymentStatus = "Paid";
          candidate.paymentId = paymentId;
          candidate.paymentDate = new Date();
          candidate.paymentMethod = payment.method || "Online";
          candidate.razorpayPaymentData = payment;
          candidate.paymentUpdatedBy = "webhook";
          await candidate.save();

         
          if (!candidate.whatsappNumber) {
            console.error("Cannot send WhatsApp: candidate.whatsappNumber is missing for", candidate._id);
          } else {
            await sendWhatsappGupshup(candidate);
          }
         // console.log('Payment updated via webhook for candidate:', candidate._id);
        }
        return res.json({ status: "ok" });
      } catch (err) {
        console.error("Webhook processing error:", err);
        return res.status(500).send("error");
      }
    }
    return res.json({ status: "ignored" });
  },

  createCandidate: async (req, res) => {
    try {
      const candidate = new Candidate(req.body);
      await candidate.save();
      return res.status(201).json(candidate);
    } catch (err) {
      console.error("Error creating candidate:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },

  getAllCandidates: async (req, res) => {
    try {
      const candidates = await Candidate.find();
      return res.json(candidates);
    } catch (err) {
      console.error("Error fetching candidates:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },

  getCandidateById: async (req, res) => {
    try {
      const candidate = await Candidate.findById(req.params.id);
      if (!candidate) {
        return res.status(404).json({ status: "fail", message: "Candidate not found" });
      }
      return res.json(candidate);
    } catch (err) {
      console.error("Error fetching candidate:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },

  updateCandidate: async (req, res) => {
    try {
      const candidate = await Candidate.findByIdAndUpdate(req.params.id, req.body, { new: true });
      if (!candidate) {
        return res.status(404).json({ status: "fail", message: "Candidate not found" });
      }
      return res.json(candidate);
    } catch (err) {
      console.error("Error updating candidate:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },

  deleteCandidate: async (req, res) => {
    try {
      const candidate = await Candidate.findByIdAndDelete(req.params.id);
      if (!candidate) {
        return res.status(404).json({ status: "fail", message: "Candidate not found" });
      }
      return res.json({ message: "Candidate deleted", candidate });
    } catch (err) {
      console.error("Error deleting candidate:", err);
      return res.status(500).json({ status: "error", message: err.message });
    }
  },



markAttendance: async (req, res) => {
  const { whatsappNumber } = req.body;
  let normalizedNumber;
  try {
    if (!whatsappNumber) {
      return res.status(400).json({ message: "WhatsApp number is required" });
    }
    if (/^\d{10}$/.test(whatsappNumber)) {
      normalizedNumber = "91" + whatsappNumber;
    } else if (/^91\d{10}$/.test(whatsappNumber)) {
      normalizedNumber = whatsappNumber;
    } else {
      return res.status(400).json({ message: "Invalid WhatsApp number format" });
    }

    let candidate = await Candidate.findOne(
      { whatsappNumber: normalizedNumber, paymentStatus: "Paid" }
    ).sort({ createdAt: -1 });

    if (!candidate) {
      const latestCandidate = await Candidate.findOne({ whatsappNumber: normalizedNumber }).sort({ createdAt: -1 });
      if (latestCandidate) {
        return res.status(403).json({ message: "Payment not completed. Attendance cannot be marked." });
      } else {
        return res.status(404).json({ message: "Candidate not found" });
      }
    }

    if (!candidate.attendanceToken) {
      candidate.attendanceToken = candidate._id.toString();
      await candidate.save();
    }

    const details = {
      status: candidate.attendance === true ? "already-marked" : "success",
      message: candidate.attendance === true ? "Attendance already taken" : undefined,
      attendanceToken: candidate.attendanceToken,
      name: candidate.name,
      email: candidate.email,
      city: candidate.city,
      college: candidate.college,
      branch: candidate.branch,
    };

    if (candidate.attendance === true) {
      return res.json(details);
    }

    candidate.attendance = true;
    await candidate.save();
    await sendWhatsappGupshup(candidate, [candidate.name], "88021e4e-88ae-4cba-bdba-f9b1be3b4948");

    res.json(details);
  } catch (err) {
    console.error("Attendance marking error:", err);
    res.status(500).json({ message: "Server error" });
  }
},

adminAttendanceScan: async (req, res) => {
  const { token } = req.body;
  try {
    const candidate = await Candidate.findOne({ attendanceToken: token });
    if (!candidate) {
      return res.status(404).json({ message: "Candidate not found" });
    }
    if (!candidate.attendance) {
      return res.status(400).json({ message: "Candidate did not mark attendance" });
    }
    if (candidate.adminAttendance) {
     
      return res.status(200).json({
        status: "already-marked",
        message: "Admin already marked attendance",
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        city: candidate.city,
        gender: candidate.gender,
        college: candidate.college,
        branch: candidate.branch,
      });
    }
    candidate.adminAttendance = true;
    candidate.adminAttendanceDate = new Date();
    await candidate.save();
    return res.status(200).json({
      status: "success",
      message: "Admin attendance marked",
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      city: candidate.city,
      gender: candidate.gender,
      college: candidate.college,
      branch: candidate.branch,
    });
  } catch (err) {
    console.error("Admin attendance scan error:", err);
    res.status(500).json({ message: "Server error" });
  }
},

adminScannedList: async (req, res) => {
  try {
    const scannedCandidates = await Candidate.find(
      { adminAttendance: true },
      {
        name: 1,
        email: 1,
        phone: 1,
        gender: 1,
        college: 1,
        branch: 1,
        adminAttendanceDate: 1,
        _id: 1
      }
    ).sort({ adminAttendanceDate: -1 });
    res.status(200).json(scannedCandidates);
  } catch (err) {
    console.error("Error fetching admin scanned list:", err);
    res.status(500).json({ message: "Server error" });
  }
},

  attendanceList: async (req, res) => {
    try {
      const attendedCandidates = await Candidate.find({ attendance: true });
      res.status(200).json(attendedCandidates);
    } catch (err) {
      console.error("Error fetching attendance list:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  deleteByName: async (req, res) => {
    try {
      const del = await Candidate.deleteMany({ name: req.body.name || 'sivva' });
      console.log(del.deletedCount);
      return res.json({ data: del.deletedCount });
    } catch (err) {
      res.status(500).json({ message: "Error deleting candidate." });
    }
  },

 verifyPaymentId: async (req, res) => {
  const { id: paymentId } = req.params;
  try {
    const candidate = await Candidate.findOne({ paymentId });
    if (!candidate) {
      return res.status(404).json({ success: false, message: "No matching candidate found for this payment ID." });
    }
    return res.status(200).json({
      success: true,
      message: "Payment verified",
      candidate,
    });
  } catch (err) {
    console.error("Payment fetch failed:", err.message);
    return res.status(500).json({ success: false, message: "Error verifying payment ID" });
  }
},
sendTemplate: async (req, res) => {
  try {
    const users = await Candidate.find({
      paymentStatus: "Paid",
      slot: "Morning"
    });

    // WhatsApp number validation
    const isValidWhatsAppNumber = (number) => {
      const cleaned = (number || "").replace(/\D/g, "");
      return /^91\d{10}$/.test(cleaned);
    };

    // Filter valid numbers
    const validUsers = users.filter(user =>
      isValidWhatsAppNumber(user.whatsappNumber)
    );

    console.log("Total candidates:", users.length);
    console.log("Valid numbers:", validUsers.length);

    const templateId = "b4af5540-be96-4c65-98a5-8c09ee42529d";
    const templateParams = ["11 AM", "10 AM","Lunch Feast"]; // adjust as per your template

    let results = [];
    let count=0;
    for (const user of validUsers) {
      count++;
      // if(count===3){
      //   break;
      // }
      const normalizedNumber = user.whatsappNumber.replace(/\D/g, ""); // remove non-digits
      try {
        const message = await gupshup.sendingTextTemplate(
          {
            template: { id: templateId, params: templateParams },
            'src.name': 'Production',
            destination: normalizedNumber,
            source: '917075176108',
          },
          { apikey: 'zbut4tsg1ouor2jks4umy1d92salxm38' }
        );
        console.log(message.data);
        // console.log(message.err)
        results.push({ user: user.name, number: normalizedNumber, status: "sent", response: message.data });
      } catch (err) {
        console.error(`Failed for ${user.name} (${normalizedNumber}):`, err.message);
        results.push({ user: user.name, number: normalizedNumber, status: "failed", error: err.message });
      }
    }

    return res.send({
      total: users.length,
      valid: validUsers.length,
      results
    });

  } catch (err) {
    console.error("Error sending template:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
}


};

module.exports = { CandidateController };
