# De Jure Academy Facebook Messenger bot
FROM node:22-alpine

# App lives here
WORKDIR /app

# Install production deps first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the application source and the knowledge base data.
# knowledge_base.json is the canonical source of truth; the .md is generated from it.
# In production, mount knowledge_base.json as a volume so /admin edits persist (see docker-compose.yml).
COPY server.js kb.js admin.js lead.js lead_capture.js store.js knowledge_base.json knowledge_base.md privacy.html ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as the unprivileged user that the node image already provides.
USER node

CMD ["node", "server.js"]
