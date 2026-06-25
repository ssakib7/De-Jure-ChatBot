# De Jure Academy Facebook Messenger bot
FROM node:22-alpine

# App lives here
WORKDIR /app

# Install production deps first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the application source.
COPY server.js knowledge_base.md ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as the unprivileged user that the node image already provides.
USER node

CMD ["node", "server.js"]
