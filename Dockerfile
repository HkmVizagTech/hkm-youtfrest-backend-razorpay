# Krishna Pulse backend — explicit build (no Nixpacks auto-detection)
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json ./
# .api/ holds the local-file dependency @api/gupshup referenced in package.json
COPY .api ./.api
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
# Railway provides PORT at runtime; the app reads process.env.PORT
EXPOSE 3300

CMD ["npm", "start"]
