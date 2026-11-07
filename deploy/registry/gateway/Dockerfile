FROM node:22-alpine
WORKDIR /app
COPY gateway.mjs .
USER node
EXPOSE 5001
CMD ["node", "gateway.mjs"]
