FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
COPY fixtures ./fixtures
EXPOSE 4000
USER node
CMD ["node", "src/server.js"]
