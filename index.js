const express = require('express');
const cors = require('cors');
const gupshup=require('@api/gupshup');
const Candidate = require('./src/models/Candidate.model');
const cron = require('node-cron');
const { Connection } = require('./src/config/db');
const { CandidateRouter } = require('./src/routes/candidate.routes');
const bodyParser = require('body-parser');
const { CandidateController } = require('./src/controllers/Candidate.controller');
const {userRouter} = require('./src/routes/user.Routes');

const app = express();

app.use(cors());
cron.schedule('* * * * *', () => {
  console.log(`[TEST CRON] Running at ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
}, { timezone: "Asia/Kolkata" });

app.post('/users/webhook', bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), CandidateController.webhook);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Welcome to the home page');
});

app.use("/users", CandidateRouter);
app.use("/admin/users", userRouter)


const PORT = process.env.PORT || 3300;
async function sendTemplateJob({ paymentStatus, slot, templateParams }) {
  try {
    const users = await Candidate.find({ paymentStatus, slot });

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const isValidWhatsAppNumber = (number) =>
      /^91\d{10}$/.test((number || "").replace(/\D/g, ""));
    const validUsers = users.filter(user =>
      isValidWhatsAppNumber(user.whatsappNumber)
    );

    console.log(`Total candidates with status "${paymentStatus}" and slot "${slot}":`, users.length);
    console.log("Valid numbers:", validUsers.length);

    const templateId = "ce707c05-54ef-4e80-b0fd-c0f9885288f6";

    for (const user of validUsers) {
      const normalizedNumber = user.whatsappNumber.replace(/\D/g, "");
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

        console.log(`✅ Sent to ${user.name}`);
        await delay(1000); // 1 sec delay between sends
      } catch (err) {
        console.error(`❌ Failed for ${user.name} (${normalizedNumber}):`, err.message);
      }
    }

    console.log("🎯 All messages processed");
  } catch (err) {
    console.error("Error in sendTemplateJob:", err);
  }
}

// --- Morning slot schedules ---
cron.schedule('0 6 * * *', async () => {
  console.log("⏰ Morning slot: 6 AM IST");
  await sendTemplateJob({
    paymentStatus: "Paid",
    slot: "Morning",
    templateParams: ["*11 PM*", "Lunch Feast"]
  });
}, { timezone: "Asia/Kolkata" });

cron.schedule('0 8 * * *', async () => {
  console.log("⏰ Morning slot: 8 AM IST");
  await sendTemplateJob({
    paymentStatus: "Paid",
    slot: "Morning",
    templateParams: ["*11 PM*", "Lunch Feast"]
  });
}, { timezone: "Asia/Kolkata" });

// --- Evening slot schedules ---
cron.schedule('0 6 * * *', async () => {
  console.log("⏰ Evening slot: 6 AM IST");
  await sendTemplateJob({
    paymentStatus: "Paid",
    slot: "Evening",
    templateParams: ["*5 PM*", "Lunch Feast"]
  });
}, { timezone: "Asia/Kolkata" });

cron.schedule('0 15 * * *', async () => {
  console.log("⏰ Evening slot: 3 PM IST");
  await sendTemplateJob({
    paymentStatus: "Paid",
    slot: "Evening",
    templateParams: ["*5 PM*", "Lunch Feast"]
  });
}, { timezone: "Asia/Kolkata" });


app.listen(PORT,'0.0.0.0', async () => {
  try {
    await Connection();
    console.log(`Server connected on port ${PORT}`);
  } catch (error) {
    console.error('Database connection failed:', error);
  }
});