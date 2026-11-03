FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]