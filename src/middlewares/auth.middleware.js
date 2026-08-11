const jwt = require('jsonwebtoken');
const userModel = require('../models/userModel');
require('dotenv').config();

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches the decoded payload to req.user.
 * Accepts an optional array of allowed roles.
 */
const authenticate = (roles = []) => (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    if (roles.length && !roles.includes(decoded.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

/**
 * For the user-registration route specifically: if no users exist yet in
 * this deployment, allow the request through with no token (bootstrapping
 * the very first admin account). Once at least one user exists, this
 * behaves exactly like authenticate(['admin']) — a valid admin Bearer token
 * is required.
 */
const requireAdminUnlessFirstUser = async (req, res, next) => {
  try {
    const userCount = await userModel.countDocuments();
    if (userCount === 0) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can create new accounts' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = { authenticate, requireAdminUnlessFirstUser };
