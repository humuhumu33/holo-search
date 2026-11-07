# The gateway and the indexer, one image: node and the verifier, at one version.
FROM node:22-alpine
WORKDIR /app
RUN npm install --no-save --no-package-lock --no-audit --no-fund prism-code@0.5.0 && npm cache clean --force
COPY gateway/gateway.mjs indexer/indexer.mjs ./
USER node
EXPOSE 5001
CMD ["node", "gateway.mjs"]
