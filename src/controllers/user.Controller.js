const userModel = require('../models/userModel');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET env var is not set. Auth will not work.');
}

const userController = {
  getUser: async (req, res) => {
    try {
      const users = await userModel.find().select('-password');
      res.status(200).json({ users, message: 'All users fetched successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  getSingleUser: async (req, res) => {
    try {
      const user = await userModel.findById(req.params.id).select('-password');
      if (!user) return res.status(404).json({ message: 'User not found' });
      res.status(200).json(user);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  createUser: async (req, res) => {
    try {
      const user = await userModel.create(req.body);
      res.status(201).json({ user, message: 'User created successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  updateUser: async (req, res) => {
    try {
      const user = await userModel.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
      if (!user) return res.status(404).json({ message: 'User not found' });
      res.status(200).json({ user, message: 'User updated successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  deleteUser: async (req, res) => {
    try {
      const user = await userModel.findByIdAndDelete(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      res.status(200).json({ message: 'User deleted successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  register: async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password)
        return res.status(400).json({ message: 'Name, email, and password are required' });

      const existing = await userModel.findOne({ email });
      if (existing) return res.status(400).json({ message: 'User already exists' });

      const hashed = await bcrypt.hash(password, 10);
      const user = await userModel.create({ name, email, password: hashed });
      res.status(201).json({ message: 'Registration successful' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password)
        return res.status(400).json({ message: 'Email and password are required' });

      const user = await userModel.findOne({ email });
      if (!user) return res.status(401).json({ message: 'Invalid email or password' });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ message: 'Invalid email or password' });

      const token = jwt.sign(
        { email: user.email, id: user._id, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(200).json({
        status: 200,
        message: 'Login successful',
        token,
        role: user.role,
        name: user.name,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
};

module.exports = userController;
