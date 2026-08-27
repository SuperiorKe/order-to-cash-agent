FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||3000) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
