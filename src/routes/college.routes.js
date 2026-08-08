const express = require('express');
const College = require('../models/College.model');

const CollegeRouter = express.Router();

// GET /college — list all colleges (used by registration dropdown + admin)
CollegeRouter.get('/', async (req, res) => {
  try {
    const colleges = await College.find().sort({ name: 1 });
    res.json(colleges);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /college — add a college
CollegeRouter.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'College name is required' });
    const college = await College.create({ name: name.trim() });
    res.status(201).json(college);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'College already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /college/:id — update a college
CollegeRouter.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'College name is required' });
    const college = await College.findByIdAndUpdate(req.params.id, { name: name.trim() }, { new: true, runValidators: true });
    if (!college) return res.status(404).json({ error: 'College not found' });
    res.json(college);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'College already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /college/:id — delete a college
CollegeRouter.delete('/:id', async (req, res) => {
  try {
    const college = await College.findByIdAndDelete(req.params.id);
    if (!college) return res.status(404).json({ error: 'College not found' });
    res.json({ message: 'College deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { CollegeRouter };
