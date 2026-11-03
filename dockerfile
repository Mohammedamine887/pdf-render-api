FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]