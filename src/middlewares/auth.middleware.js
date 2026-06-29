const jwt = require('jsonwebtoken');
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

module.exports = { authenticate };
