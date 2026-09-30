FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=192"
ENV PORT=3000

EXPOSE 3000

CMD ["node", "./uvStandalone.mjs"]
