FROM node:24-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=160 --optimize-for-size"

CMD ["npm", "start"]
