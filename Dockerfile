FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build && cp -r public dist/public
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
