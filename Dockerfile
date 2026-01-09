FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN npm install pm2 -g
COPY --from=builder /app/dist ./dist
EXPOSE 8080

ENTRYPOINT ["pm2-runtime", "dist/bundle.js"]