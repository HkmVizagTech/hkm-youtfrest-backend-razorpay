const express = require('express');
const cors = require('cors');
const { Connection } = require('./src/config/db');
const { CandidateRouter } = require('./src/routes/candidate.routes');
const bodyParser = require('body-parser');
const { CandidateController } = require('./src/controllers/Candidate.controller');

const app = express();

app.use(cors());


app.post('/users/webhook', bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), CandidateController.webhook);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Welcome to the home page');
});

app.use("/users", CandidateRouter);

const PORT = process.env.PORT || 3300;

app.listen(PORT,'0.0.0.0', async () => {
  try {
    await Connection();
    console.log(`Server connected on port ${PORT}`);
  } catch (error) {
    console.error('Database connection failed:', error);
  }
});